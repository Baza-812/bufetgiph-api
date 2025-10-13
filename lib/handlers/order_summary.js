// /api/order_summary.js — summary по orderId ИЛИ по (org, employeeID, date)
// Расширенный поиск: пробуем несколько имён поля даты, затем JS-фильтрация, затем fallback через Request Log.
// Поддерживает debug=1.

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
  ORDER_STATUS:  env('FLD_ORDER_STATUS',  'Status'),
  ORDER_TYPE:    env('FLD_ORDER_TYPE',    'Order Type'), // если есть
  // Request Log
  RL_DATE:       env('FLD_RL_DATE',       'Date'),
  RL_EMP:        env('FLD_RL_EMP',        'Employee'),
  RL_ORDER:      env('FLD_RL_ORDER',      'Order'),
};

const DATE_FIELDS_ORDERS = [
  'Order Date', 'Date', 'Delivery Date', 'Delivery', 'Requested Date', 'Дата'
];

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

function hasEmployeeInAnyArrayField(fields, employeeID) {
  if (!fields || typeof fields !== 'object') return false;
  for (const v of Object.values(fields)) {
    if (Array.isArray(v) && v.includes(employeeID)) return true;
  }
  return false;
}

async function fetchOrderSummaryById(orderId) {
  const r = await atGet(TABLE.ORDERS, {
    filterByFormula: `RECORD_ID()='${orderId}'`,
    maxRecords: 1,
    // тянем все поля — нам важны только дата/статус, но так надёжнее при разнобое
  });
  const rec = one(r.records);
  if (!rec) return null;
  const f = rec.fields || {};

  // попытаемся вытащить дату из любого известного поля
  let dateVal = '';
  for (const k of DATE_FIELDS_ORDERS) {
    if (typeof f[k] === 'string') { dateVal = f[k]; break; }
  }

  return { orderId: rec.id, date: dateVal, status: f[FLD.ORDER_STATUS] || '' };
}

async function searchOrdersByDateField(date, dateField) {
  const resp = await atGet(TABLE.ORDERS, {
    filterByFormula: `{${dateField}}='${date}'`,
    pageSize: 100,
  });
  return resp.records || [];
}

async function searchOrdersByDateAnyFieldJS(date) {
  // широкая выборка и фильтр в JS
  const resp = await atGet(TABLE.ORDERS, {
    // можно добавить сортировку по времени создания, если есть соответствующее поле
    pageSize: 100,
  });
  const recs = resp.records || [];
  return recs.filter((r) => {
    const f = r.fields || {};
    return DATE_FIELDS_ORDERS.some((k) => (typeof f[k] === 'string' && f[k] === date));
  });
}

async function searchInRequestLog(date, employeeID) {
  // Ищем по дате и наличию employeeID в любом массивном поле
  // Для надёжности сначала отберём по дате (по полю RL_DATE), а потом проверим наличие employeeID в массивах
  const resp = await atGet(TABLE.REQLOG, {
    filterByFormula: `{${FLD.RL_DATE}}='${date}'`,
    pageSize: 50,
  });
  const recs = resp.records || [];
  const matched = recs.find((r) => hasEmployeeInAnyArrayField(r.fields, employeeID));
  const orderId = matched?.fields?.[FLD.RL_ORDER]?.[0] || null;
  return { matched, orderId, all: recs };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });
  if (!BASE || !APIKEY)         return json(res, 500, { error: 'Missing AIRTABLE_* env' });

  try {
    const q = req.query || {};
    const debug = String(q.debug || '') === '1';
    const orderId = q.orderId;

    // ---- Режим 1: по orderId
    if (orderId) {
      const summary = await fetchOrderSummaryById(orderId);
      if (!summary) return json(res, 404, { error: 'order not found' });
      return json(res, 200, debug ? { ok: true, mode: 'byId', summary } : { ok: true, summary });
    }

    // ---- Режим 2: по org + employeeID + date
    const org = q.org; // пока не используем в фильтре
    const employeeID = q.employeeID;
    const date = q.date;
    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    const diag = debug ? { triedDateFields: [], ordersByField: {}, fallbackListCount: 0, reqlog: null } : undefined;

    // 1) Пробуем по известным полям даты
    let foundOrders = [];
    for (const df of DATE_FIELDS_ORDERS) {
      try {
        const list = await searchOrdersByDateField(date, df);
        if (debug) {
          diag.triedDateFields.push(df);
          diag.ordersByField[df] = (list || []).map((r) => r.id);
        }
        if (list && list.length) { foundOrders = list; break; }
      } catch {
        // поле может отсутствовать — это нормально
      }
    }

    // 2) Если нет — широкая выборка и JS-фильтр по дате
    if (!foundOrders.length) {
      const list = await searchOrdersByDateAnyFieldJS(date);
      if (debug) diag.fallbackListCount = list.length;
      foundOrders = list;
    }

    // 3) Из найденных по дате выбираем те, где есть линк на employeeID
    let candidate = foundOrders.find((r) => hasEmployeeInAnyArrayField(r.fields, employeeID));

    // Если нескольких — попробуем предпочесть менеджерские
    if (!candidate) {
      const managers = foundOrders.filter(
        (r) =>
          hasEmployeeInAnyArrayField(r.fields, employeeID) &&
          String((r.fields || {})[FLD.ORDER_TYPE] || '').toLowerCase() === 'manager',
      );
      if (managers.length) candidate = managers[0];
    }

    // 4) Если в Orders так и не нашли — идём в Request Log
    if (!candidate) {
      const rlog = await searchInRequestLog(date, employeeID);
      if (debug) diag.reqlog = {
        matched: rlog.matched ? { id: rlog.matched.id, fields: rlog.matched.fields } : null,
        allCount: rlog.all.length
      };
      if (rlog.orderId) {
        const summary = await fetchOrderSummaryById(rlog.orderId);
        return json(res, 200, debug ? { ok: true, mode: 'via_reqlog', summary, diag } : { ok: true, summary });
      }
      return json(res, 200, debug ? { ok: true, summary: null, diag } : { ok: true, summary: null });
    }

    // 5) Возвращаем сводку по найденному заказу
    const f = candidate.fields || {};
    let dateVal = '';
    for (const k of DATE_FIELDS_ORDERS) {
      if (typeof f[k] === 'string') { dateVal = f[k]; break; }
    }
    const summary = { orderId: candidate.id, date: dateVal || date, status: f[FLD.ORDER_STATUS] || '' };
    return json(res, 200, debug ? { ok: true, mode: 'orders', summary, diag } : { ok: true, summary });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
