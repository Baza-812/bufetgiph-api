// /api/order_summary.js — summary по orderId ИЛИ по (org, employeeID, date)

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
};

function json(res, c, d) {
  res.statusCode = c;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(d));
}

const atHeaders = () => ({ Authorization: `Bearer ${APIKEY}`, 'Content-Type': 'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;
async function atGet(t, p = {}) {
  const usp = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((vv) => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}
const one = (a) => (Array.isArray(a) && a.length ? a[0] : null);

// ----------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });
  if (!BASE || !APIKEY)         return json(res, 500, { error: 'Missing AIRTABLE_* env' });

  try {
    const q = req.query || {};
    const orderId = q.orderId;

    // ---- РЕЖИМ 1: по orderId
    if (orderId) {
      const r = await atGet(TABLE.ORDERS, {
        filterByFormula: `RECORD_ID()='${orderId}'`,
        maxRecords: 1,
        "fields[]": ['Order Date', 'Status'],
      });
      const rec = one(r.records);
      if (!rec) return json(res, 404, { error: 'order not found' });
      const f = rec.fields || {};
      return json(res, 200, {
        ok: true,
        summary: { orderId: rec.id, date: f['Order Date'] || '', status: f['Status'] || '' },
      });
    }

    // ---- РЕЖИМ 2: по org + employeeID + date
    const org = q.org;
    const employeeID = q.employeeID;
    const date = q.date;

    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    // Ищем заказ строго по дате и по линк-полю Employee (массив recordId).
    // Статус НЕ фильтруем — «New» тоже учитываем как «заказ есть».
    const formula = `AND(
      {Order Date}='${date}',
      FIND('${employeeID}', ARRAYJOIN({Employee}))
    )`;

    const orders = await atGet(TABLE.ORDERS, {
      filterByFormula: formula,
      maxRecords: 1,
      "fields[]": ['Order Date', 'Status'],
    });

    const found = one(orders.records);
    if (!found) return json(res, 200, { ok: true, summary: null });

    const sf = found.fields || {};
    return json(res, 200, {
      ok: true,
      summary: { orderId: found.id, date: sf['Order Date'] || date, status: sf['Status'] || '' },
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
