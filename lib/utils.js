// lib/utils.js
function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

// ===== TABLE NAMES =====
const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  MENU:       env('TBL_MENU',       'Menu'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
  BANKS:      env('TBL_BANKS',      'Banks'),
  PAYMENTS:   env('TBL_PAYMENTS',   'Payments'),
  REQLOG:     env('TBL_REQLOG',     'Request Log'),
};

// ===== FIELD NAMES =====

// Employees
const EMP_ORG_LINK   = env('FLD_EMP_ORG_LINK',   'Organization');
const EMP_ORG_LOOKUP = env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)');
const EMP_TOKEN      = env('FLD_EMP_TOKEN',      'Order Token');
const EMP_STATUS     = env('FLD_EMP_STATUS',     'Status');
const EMP_ROLE       = env('FLD_EMP_ROLE',       'Role');
const EMP_NAME       = env('FLD_EMP_NAME',       'FullName');
const EMP_EMAIL      = env('FLD_EMP_EMAIL',      'Email');

// Organizations
const ORG_ID           = env('FLD_ORG_ID',         'OrgID');
const ORG_NAME         = env('FLD_ORG_NAME',       'Name');
const ORG_VID_DOGOVORA = env('FLD_ORG_VID_DOGOVORA', 'VidDogovora');
const ORG_PRICE_FULL   = env('FLD_ORG_PRICE_FULL', 'PriceFull');
const ORG_PRICE_LIGHT  = env('FLD_ORG_PRICE_LIGHT','PriceLight');
const ORG_CUTOFF_TIME  = env('FLD_ORG_CUTOFF_TIME', 'Cutoff Time');
const ORG_BANK         = env('FLD_ORG_BANK',       'Bank');

// Orders
const ORDER_DATE       = env('FLD_ORDER_DATE',     'Order Date');
const ORDER_STATUS     = env('FLD_ORDER_STATUS',   'Status');
const ORDER_EMPLOYEE   = env('FLD_ORDER_EMPLOYEE', 'Employee');
const ORDER_MB_LINK    = env('FLD_ORDER_MB_LINK',  'Meal Boxes');
const ORDER_OL_LINK    = env('FLD_ORDER_OL_LINK',  'Order Lines');
const ORDER_NO         = env('FLD_ORDER_NO',       'Order No');
const ORDER_ORG_ID     = env('FLD_ORDER_ORG_ID',   'Org');
const ORDER_TYPE       = env('FLD_ORDER_TYPE',     'Order Type');
const ORDER_PROGRAM    = env('FLD_ORDER_PROGRAM',  'ProgramType');
const ORDER_TARIFF     = env('FLD_ORDER_TARIFF',   'TariffCode');
const ORDER_PAYMENT    = env('FLD_ORDER_PAYMENT',  'PaymentMethod');
const ORDER_PAYMENT_LINK = env('FLD_ORDER_PAYMENT_LINK', 'Payment'); // link to Payments

// Meal Boxes
const MB_ORDER      = env('FLD_MB_ORDER',      'Order');
const MB_MAIN       = env('FLD_MB_MAIN',       'Main (Menu Item)');
const MB_SIDE       = env('FLD_MB_SIDE',       'Side (Menu Item)');
const MB_QTY        = env('FLD_MB_QTY',        'Quantity');
const MB_TYPE       = env('FLD_MB_TYPE',       'Line Type');
const MB_SUM        = env('FLD_MB_SUM',        'Line Sum');
const MB_MAIN_NAME  = env('FLD_MB_MAIN_NAME',  'Main Name');
const MB_SIDE_NAME  = env('FLD_MB_SIDE_NAME',  'Side Name');

// Order Lines
const OL_ORDER = env('FLD_OL_ORDER', 'Order');
const OL_ITEM  = env('FLD_OL_ITEM',  'Item (Menu Item)');
const OL_QTY   = env('FLD_OL_QTY',   'Quantity');
const OL_TYPE  = env('FLD_OL_TYPE',  'Line Type');
const OL_SUM   = env('FLD_OL_SUM',   'Line Sum');
const OL_NAME  = env('FLD_OL_NAME',  'Item Name');

// Banks
const BANK_NAME                  = env('FLD_BANK_NAME',                  'Name');
const BANK_LEGAL_NAME            = env('FLD_BANK_LEGAL_NAME',            'LegalName');
const BANK_BANK_NAME             = env('FLD_BANK_BANK_NAME',             'BankName');
const BANK_INN                   = env('FLD_BANK_INN',                   'INN');
const BANK_ACQUIRING_PROVIDER    = env('FLD_BANK_ACQUIRING_PROVIDER',    'AcquiringProvider');
const BANK_TERMINAL_ID           = env('FLD_BANK_TERMINAL_ID',           'TerminalID');
const BANK_MERCHANT_ID           = env('FLD_BANK_MERCHANT_ID',           'MerchantID');
const BANK_API_KEY               = env('FLD_BANK_API_KEY',               'APIKey');
const BANK_PAYMENT_PAGE_BASE_URL = env('FLD_BANK_PAYMENT_PAGE_BASE_URL', 'PaymentPageBaseURL');
const BANK_FOOTER_TEXT           = env('FLD_BANK_FOOTER_TEXT',           'FooterText');
const BANK_IS_ACTIVE             = env('FLD_BANK_IS_ACTIVE',             'IsActive');

// Payments
const PAYMENT_ID          = env('FLD_PAYMENT_ID',          'PaymentID');
const PAYMENT_ORGANIZATION = env('FLD_PAYMENT_ORGANIZATION', 'Organization');
const PAYMENT_EMPLOYEE    = env('FLD_PAYMENT_EMPLOYEE',    'Employee');
const PAYMENT_AMOUNT      = env('FLD_PAYMENT_AMOUNT',      'Amount');
const PAYMENT_STATUS      = env('FLD_PAYMENT_STATUS',      'Status');
const PAYMENT_METHOD      = env('FLD_PAYMENT_METHOD',      'PaymentMethod');
const PAYMENT_PROVIDER    = env('FLD_PAYMENT_PROVIDER',    'Provider');
const PAYMENT_EXTERNAL_ID = env('FLD_PAYMENT_EXTERNAL_ID', 'ExternalID');
const PAYMENT_LINK        = env('FLD_PAYMENT_LINK',        'PaymentLink');
const PAYMENT_ORDERS      = env('FLD_PAYMENT_ORDERS',      'Orders');
const PAYMENT_CREATED_AT  = env('FLD_PAYMENT_CREATED_AT',  'CreatedAt');
const PAYMENT_PAID_AT     = env('FLD_PAYMENT_PAID_AT',     'PaidAt');
const PAYMENT_NOTES       = env('FLD_PAYMENT_NOTES',       'Notes');

// ===== FIELD OBJECT =====
const F = {
  // Employees
  EMP_ORG_LINK,
  EMP_ORG_LOOKUP,
  EMP_TOKEN,
  EMP_STATUS,
  EMP_ROLE,
  EMP_NAME,
  EMP_EMAIL,

  // Organizations
  ORG_ID,
  ORG_NAME,
  ORG_VID_DOGOVORA,
  ORG_PRICE_FULL,
  ORG_PRICE_LIGHT,
  ORG_CUTOFF_TIME,
  ORG_BANK,

  // Orders
  ORDER_DATE,
  ORDER_STATUS,
  ORDER_EMPLOYEE,
  ORDER_MB_LINK,
  ORDER_OL_LINK,
  ORDER_NO,
  ORDER_ORG_ID,
  ORDER_TYPE,
  ORDER_PROGRAM,
  ORDER_TARIFF,
  ORDER_PAYMENT,
  ORDER_PAYMENT_LINK,

  // Meal Boxes
  MB_ORDER,
  MB_MAIN,
  MB_SIDE,
  MB_QTY,
  MB_TYPE,
  MB_SUM,
  MB_MAIN_NAME,
  MB_SIDE_NAME,

  // Order Lines
  OL_ORDER,
  OL_ITEM,
  OL_QTY,
  OL_TYPE,
  OL_SUM,
  OL_NAME,

  // Banks
  BANK_NAME,
  BANK_LEGAL_NAME,
  BANK_BANK_NAME,
  BANK_INN,
  BANK_ACQUIRING_PROVIDER,
  BANK_TERMINAL_ID,
  BANK_MERCHANT_ID,
  BANK_API_KEY,
  BANK_PAYMENT_PAGE_BASE_URL,
  BANK_FOOTER_TEXT,
  BANK_IS_ACTIVE,

  // Payments
  PAYMENT_ID,
  PAYMENT_ORGANIZATION,
  PAYMENT_EMPLOYEE,
  PAYMENT_AMOUNT,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  PAYMENT_PROVIDER,
  PAYMENT_EXTERNAL_ID,
  PAYMENT_LINK,
  PAYMENT_ORDERS,
  PAYMENT_CREATED_AT,
  PAYMENT_PAID_AT,
  PAYMENT_NOTES,
};

// ===== HELPERS =====

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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

async function atGet(table, recordIdOrParams) {
  // Если передан строковый ID — получаем одну запись
  if (typeof recordIdOrParams === 'string') {
    const r = await fetchWithRetry(`${atUrl(table)}/${recordIdOrParams}`, { headers: atHeaders() });
    return r.json();
  }
  
  // Иначе — список с параметрами
  const params = recordIdOrParams || {};
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(vv => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const r = await fetchWithRetry(`${atUrl(table)}?${usp}`, { headers: atHeaders() });
  return r.json();
}

async function atCreate(table, body) {
  const r = await fetchWithRetry(atUrl(table), { method: 'POST', headers: atHeaders(), body: JSON.stringify(body) });
  return r.json();
}

async function atPost(table, body) {
  return atCreate(table, body);
}

async function atPatch(table, body) {
  const r = await fetchWithRetry(atUrl(table), { method: 'PATCH', headers: atHeaders(), body: JSON.stringify(body) });
  return r.json();
}

async function atList(table, params = {}) {
  return atGet(table, params);
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
  atGet, atPost, atCreate, atPatch, atList, listAll, one,
  TABLE, F, BASE, APIKEY,
  getLinkId,
};
