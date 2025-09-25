// api/_utils.js
function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  MENU:       env('TBL_MENU',       'Menu'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
  REQLOG:     env('TBL_REQLOG',     'Request Log'),
};

const F = {
  // Employees
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),
  EMP_ROLE:       env('FLD_EMP_ROLE',       'Role'),
  EMP_NAME:       env('FLD_EMP_NAME',       'FullName'),

  // Orders
  ORDER_DATE:     env('FLD_ORDER_DATE',     'Order Date'),
  ORDER_STATUS:   env('FLD_ORDER_STATUS',   'Status'),
  ORDER_EMPLOYEE: env('FLD_ORDER_EMPLOYEE', 'Employee'),
  ORDER_MB_LINK:  env('FLD_ORDER_MB_LINK',  'Meal Boxes'),
  ORDER_OL_LINK:  env('FLD_ORDER_OL_LINK',  'Order Lines'),
  ORDER_NO:       env('FLD_ORDER_NO',       'Order No'),
  ORDER_ORG:      env('FLD_ORDER_ORG',      'Org'),
  ORDER_TYPE:     env('FLD_ORDER_TYPE',     'Order Type'),

  // Meal Boxes
  MB_ORDER:      env('FLD_MB_ORDER',      'Order'),
  MB_MAIN:       env('FLD_MB_MAIN',       'Main (Menu Item)'),
  MB_SIDE:       env('FLD_MB_SIDE',       'Side (Menu Item)'),
  MB_QTY:        env('FLD_MB_QTY',        'Quantity'),
  MB_TYPE:       env('FLD_MB_TYPE',       'Line Type'),
  MB_SUM:        env('FLD_MB_SUM',        'Line Sum'),
  MB_MAIN_NAME:  env('FLD_MB_MAIN_NAME',  'Main Name'), // Lookup/Formula
  MB_SIDE_NAME:  env('FLD_MB_SIDE_NAME',  'Side Name'), // Lookup/Formula

  // Order Lines
  OL_ORDER: env('FLD_OL_ORDER', 'Order'),
  OL_ITEM:  env('FLD_OL_ITEM',  'Item (Menu Item)'),
  OL_QTY:   env('FLD_OL_QTY',   'Quantity'),
  OL_TYPE:  env('FLD_OL_TYPE',  'Line Type'),
  OL_SUM:   env('FLD_OL_SUM',   'Line Sum'),
  OL_NAME:  env('FLD_OL_NAME',  'Item Name'), // Lookup/Formula
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

// === fetch с ретраями на 429/5xx
async function fetchWithRetry(url, opts = {}, attempts = 5, baseDelayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    if (r.status !== 429 && r.status < 500) {
      const t = await r.text();
      throw new Error(`${opts.method || 'GET'} ${url}: ${r.status} ${t}`);
    }
    lastErr = r;
    const ra = r.headers.get('retry-after');
    const wait = ra ? Number(ra) * 1000 : baseDelayMs * Math.pow(2, i);
    await new Promise(res => setTimeout(res, wait));
  }
  const txt = lastErr ? await lastErr.text() : 'no response';
  throw new Error(`fetchWithRetry failed: ${txt}`);
}

const atHeaders = () => ({ Authorization: `Bearer ${APIKEY}`, 'Content-Type': 'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(table, params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(vv => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const r = await fetchWithRetry(`${atUrl(table)}?${usp}`, { headers: atHeaders() });
  return r.json();
}
async function atPost(table, body) {
  const r = await fetchWithRetry(atUrl(table), { method: 'POST', headers: atHeaders(), body: JSON.stringify(body) });
  return r.json();
}
async function atPatch(table, body) {
  const r = await fetchWithRetry(atUrl(table), { method: 'PATCH', headers: atHeaders(), body: JSON.stringify(body) });
  return r.json();
}

function withRateLimit(handler, { windowMs = 5000, max = 15, keyer } = {}) {
  const store = (globalThis.__rateLimitStore ||= new Map());
  return async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
      const key = (keyer ? keyer(req) : ip) || 'unknown';
      const now = Date.now();
      const bucket = store.get(key) || { count: 0, reset: now + windowMs };
      if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + windowMs; }
      bucket.count += 1;
      store.set(key, bucket);
      if (bucket.count > max) return json(res, 429, { error: 'rate_limit', retryAfterMs: bucket.reset - now });
      return await handler(req, res);
    } catch (e) {
      return json(res, 500, { error: e.message || String(e) });
    }
  };
}

const one = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

async function listAll(table, params = {}) {
  let out = [], offset;
  do {
    const p = { ...params }; if (offset) p.offset = offset;
    const r = await atGet(table, p);
    out = out.concat(r.records || []);
    offset = r.offset;
  } while (offset);
  return out;
}

// Helpers
function getLinkId(val) {
  // link-поле может быть массивом строк-ids или пустым
  if (!val) return null;
  if (Array.isArray(val) && val.length) return val[0];
  return null;
}

module.exports = {
  env, json, fetchWithRetry, withRateLimit,
  atGet, atPost, atPatch, listAll, one,
  TABLE, F, BASE, APIKEY,
  getLinkId,
};
