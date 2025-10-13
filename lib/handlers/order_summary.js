// /api/order_summary.js — summary по orderId ИЛИ по (org, employeeID, date)
// Диагностический режим debug=1: возвращает подробности поиска.

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
  ORDER_DATE:    env('FLD_ORDER_DATE',    'Order Date'),
  ORDER_STATUS:  env('FLD_ORDER_STATUS',  'Status'),
  ORDER_TYPE:    env('FLD_ORDER_TYPE',    'Order Type'), // может отсутствовать
  RL_DATE:       env('FLD_RL_DATE',       'Date'),
  RL_EMP:        env('FLD_RL_EMP',        'Employee'),
  RL_ORDER:      env('FLD_RL_ORDER',      'Order'),
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

// true, если в любом массивном поле встречается employeeID
function hasEmployeeInAnyArrayField(fields, employeeID) {
  if (!fields || typeof fields !== 'object') return false;
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v) && v.includes(employeeID)) return true;
  }
  return false;
}

// true, если где-то хранится employeeID как строка (на всякий случай)
function hasEmployeeAsStringSomewhere(fields, employeeID) {
  if (!fields || typeof fields !== 'object') return false;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.includes(employeeID)) return true;
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
    const debug = String(q.debug || '') === '1';
    const orderId = q.orderId;

    // ---- РЕЖИМ 1: по orderId
    if (orderId) {
      const summary = await fetchOrderSummaryById(orderId);
      if (!summary) return json(res, 404, { error: 'order not found' });
      return json(res, 200, debug ? { ok: true, mode: 'byId', summary } : { ok: true, summary });
    }

    // ---- РЕЖИМ 2: по org + employeeID + date
    const org = q.org; // сейчас не используем в фильтре; можно добавить при необходимости
    const employeeID = q.employeeID;
    const date = q.date;
    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    // 2.1. Тянем ВСЕ заказы на дату
    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `{${FLD.ORDER_DATE}}='${date}'`,
      pageSize: 100,
    });
    const allOnDate = ordersResp.records || [];

    // 2.2. Составим диагностику по каждому найденному заказу
    const diagOrders = debug
      ? allOnDate.map((r) => {
          const f = r.fields || {};
          const arraysWithEmp = Object.entries(f)
            .filter(([, v]) => Array.isArray(v) && v.includes(employeeID))
            .map(([k]) => k);
          const arraysAll = Object.entries(f)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => ({ field: k, length: Array.isArray(v) ? v.length : 0 }));
          return {
            id: r.id,
            status: f[FLD.ORDER_STATUS] || '',
            type: f[FLD.ORDER_TYPE] || '',
            arraysWithEmp,
            hasAnyArray: arraysAll.length > 0,
            arraysAll,
            hasEmployeeAsString: hasEmployeeAsStringSomewhere(f, employeeID),
          };
        })
      : undefined;

    // 2.3. Сначала ищем «менеджерский» (если поле Order Type есть)
    let found = allOnDate.find(
      (r) =>
        hasEmployeeInAnyArrayField(r.fields, employeeID) &&
        String((r.fields || {})[FLD.ORDER_TYPE] || '').toLowerCase() === 'manager',
    );

    // 2.4. Если не нашли — любой заказ этого сотрудника на дату
    if (!found) {
      found = allOnDate.find((r) => hasEmployeeInAnyArrayField(r.fields, employeeID));
    }

    // 2.5. Если всё ещё не нашли — фолбэк через Request Log
    let diagReqLog;
    if (!found) {
      const logResp = await atGet(TABLE.REQLOG, {
        filterByFormula: `AND(
          {${FLD.RL_DATE}}='${date}',
          FIND('${employeeID}', ARRAYJOIN({${FLD.RL_EMP}}))
        )`,
        maxRecords: 3,
        "fields[]": [FLD.RL_ORDER, FLD.RL_EMP, FLD.RL_DATE],
      });
      const logs = logResp.records || [];
      diagReqLog = debug
        ? logs.map((r) => ({
            id: r.id,
            order: (r.fields || {})[FLD.RL_ORDER],
            emp: (r.fields || {})[FLD.RL_EMP],
            date: (r.fields || {})[FLD.RL_DATE],
          }))
        : undefined;

      const firstWithOrder = logs.find((r) => Array.isArray(r.fields?.[FLD.RL_ORDER]) && r.fields[FLD.RL_ORDER][0]);
      const linkedOrderId = firstWithOrder?.fields?.[FLD.RL_ORDER]?.[0];
      if (linkedOrderId) {
        const sum = await fetchOrderSummaryById(linkedOrderId);
        return json(res, 200, debug ? { ok: true, mode: 'via_reqlog', summary: sum, diag: { orders: diagOrders, reqlog: diagReqLog } } : { ok: true, summary: sum });
      }
    }

    if (!found) {
      return json(res, 200, debug ? { ok: true, summary: null, diag: { orders: diagOrders } } : { ok: true, summary: null });
    }

    const f = found.fields || {};
    const summary = { orderId: found.id, date: f[FLD.ORDER_DATE] || date, status: f[FLD.ORDER_STATUS] || '' };
    return json(res, 200, debug ? { ok: true, mode: 'orders', summary, diag: { orders: diagOrders } } : { ok: true, summary });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
