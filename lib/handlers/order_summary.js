// /api/order_summary.js — summary по orderId ИЛИ по (org, employeeID, date)
// Ищем по Orders; если не нашли, фолбэк через Request Log.

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
  MENU:       env('TBL_MENU',       'Menu'),
  REQLOG:     env('TBL_REQLOG',     'Request Log'),
};

const FLD = {
  ORDER_DATE:  env('FLD_ORDER_DATE',  'Order Date'),
  ORDER_STATUS:env('FLD_ORDER_STATUS','Status'),
  RL_DATE:     env('FLD_RL_DATE',     'Date'),
  RL_EMP:      env('FLD_RL_EMP',      'Employee'),
  RL_ORDER:    env('FLD_RL_ORDER',    'Order'),
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

// Проверяем, содержит ли запись Orders ссылку на employeeID в любом массивном поле
function recordHasEmployeeLink(recFields, employeeID) {
  if (!recFields || typeof recFields !== 'object') return false;
  for (const v of Object.values(recFields)) {
    if (Array.isArray(v) && v.includes(employeeID)) return true;
  }
  return false;
}

async function fetchOrderSummaryById(orderId) {
  const r = await atGet(TABLE.ORDERS, {
    filterByFormula: `RECORD_ID()='${orderId}'`,
    maxRecords: 1,
    "fields[]": [FLD.ORDER_DATE, FLD.ORDER_STATUS],
  });
  const rec = one(r.records);
  if (!rec) return null;
  const f = rec.fields || {};
  return { orderId: rec.id, date: f[FLD.ORDER_DATE] || '', status: f[FLD.ORDER_STATUS] || '' };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });
  if (!BASE || !APIKEY)         return json(res, 500, { error: 'Missing AIRTABLE_* env' });

  try {
    const q = req.query || {};
    const orderId = q.orderId;

    // ---- РЕЖИМ 1: по orderId
    if (orderId) {
      const summary = await fetchOrderSummaryById(orderId);
      if (!summary) return json(res, 404, { error: 'order not found' });
      return json(res, 200, { ok: true, summary });
    }

    // ---- РЕЖИМ 2: по org + employeeID + date
    const org = q.org;                    // сейчас org не используем в фильтре, при необходимости добавим
    const employeeID = q.employeeID;
    const date = q.date;
    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    // 2.1. Пытаемся найти заказ в Orders на эту дату, где ЛЮБОЕ массивное поле содержит employeeID
    // (имя поля линка может отличаться — ищем в JS)
    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `{${FLD.ORDER_DATE}}='${date}'`,
      pageSize: 100,
    });

    let found = (ordersResp.records || []).find((r) => recordHasEmployeeLink(r.fields, employeeID));

    // 2.2. Если не нашли — пробуем через Request Log (лог заказа из order_manager.js)
    if (!found) {
      const logResp = await atGet(TABLE.REQLOG, {
        filterByFormula: `AND(
          {${FLD.RL_DATE}}='${date}',
          FIND('${employeeID}', ARRAYJOIN({${FLD.RL_EMP}}))
        )`,
        maxRecords: 1,
        "fields[]": [FLD.RL_ORDER],
      });
      const logRec = one(logResp.records);
      const linkedOrderId = logRec?.fields?.[FLD.RL_ORDER]?.[0];
      if (linkedOrderId) {
        const summary = await fetchOrderSummaryById(linkedOrderId);
        return json(res, 200, { ok: true, summary: summary || null });
      }
    }

    if (!found) return json(res, 200, { ok: true, summary: null });

    // 2.3. Возвращаем сводку по найденному заказу
    const f = found.fields || {};
    return json(res, 200, {
      ok: true,
      summary: { orderId: found.id, date: f[FLD.ORDER_DATE] || date, status: f[FLD.ORDER_STATUS] || '' },
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
