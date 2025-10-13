// /api/order_summary.js — summary по orderId ИЛИ по (org, employeeID, date)
// Возвращает: { ok:true, summary: { orderId, date, status, boxes[], extras[], lines[] } | null }

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
  const orderResp = await atGet(TABLE.ORDERS, {
    filterByFormula: `RECORD_ID()='${orderId}'`,
    maxRecords: 1,
  });
  const order = one(orderResp.records);
  if (!order) return null;
  const of = order.fields || {};

  let dateVal = '';
  for (const k of DATE_FIELDS_ORDERS) { if (typeof of[k] === 'string') { dateVal = of[k]; break; } }
  const status = of[FLD.ORDER_STATUS] || '';

  // Meal Boxes
  const mbResp = await atGet(TABLE.MEALBOXES, {
    filterByFormula: `FIND('${orderId}', ARRAYJOIN({Order}))`,
    "fields[]": ['Main (Menu Item)', 'Side (Menu Item)', 'Quantity'],
    pageSize: 100,
  });
  const mb = mbResp.records || [];

  // Order Lines (extras)
  const olResp = await atGet(TABLE.ORDERLINES, {
    filterByFormula: `FIND('${orderId}', ARRAYJOIN({Order}))`,
    "fields[]": ['Item (Menu Item)', 'Quantity'],
    pageSize: 100,
  });
  const ol = olResp.records || [];

  // собрать id из меню
  const menuIds = new Set();
  mb.forEach(r => {
    const f = r.fields || {};
    (f['Main (Menu Item)'] || []).forEach(id => menuIds.add(id));
    (f['Side (Menu Item)'] || []).forEach(id => menuIds.add(id));
  });
  ol.forEach(r => {
    const f = r.fields || {};
    (f['Item (Menu Item)'] || []).forEach(id => menuIds.add(id));
  });

  // карточки меню для названий/категорий
  const names = {};
  const cats  = {};
  if (menuIds.size) {
    const orList = Array.from(menuIds).map(id => `RECORD_ID()='${id}'`).join(',');
    const mResp = await atGet(TABLE.MENU, {
      filterByFormula: `OR(${orList})`,
      "fields[]": ['Name', 'Category', 'Extra Category', 'Dish Category', 'Menu Category'],
      pageSize: 100,
    });
    (mResp.records || []).forEach(r => {
      const f = r.fields || {};
      names[r.id] = f['Name'] || r.id;
      cats[r.id]  = f['Category'] || f['Extra Category'] || f['Dish Category'] || f['Menu Category'] || '';
    });
  }

  const boxes = mb.map(r => {
    const f = r.fields || {};
    const mainId = (f['Main (Menu Item)'] || [])[0] || null;
    const sideId = (f['Side (Menu Item)'] || [])[0] || null;
    const qty    = Math.max(0, Number(f['Quantity'] || 0));
    return { mainId, sideId, qty };
  });

  const extras = ol.map(r => {
    const f = r.fields || {};
    const itemId = (f['Item (Menu Item)'] || [])[0] || null;
    const qty    = Math.max(0, Number(f['Quantity'] || 0));
    return { itemId, qty, category: itemId ? (cats[itemId] || '') : '' };
  });

  const lines = [
    ...boxes.filter(b => b.qty > 0).map(b => {
      const m = b.mainId ? names[b.mainId] : '';
      const s = b.sideId ? names[b.sideId] : '';
      return `${m || '—'}${s ? ' + ' + s : ''} × ${b.qty}`;
    }),
    ...extras.filter(e => e.qty > 0).map(e => `${e.itemId ? names[e.itemId] || e.itemId : '—'} × ${e.qty}`),
  ];

  return { orderId, date: dateVal, status, boxes, extras, lines };
}

async function searchOrdersByDateField(date, dateField) {
  const resp = await atGet(TABLE.ORDERS, {
    filterByFormula: `{${dateField}}='${date}'`,
    pageSize: 100,
  });
  return resp.records || [];
}

async function searchOrdersByDateAnyFieldJS(date) {
  const resp = await atGet(TABLE.ORDERS, { pageSize: 100 });
  const recs = resp.records || [];
  return recs.filter(r => {
    const f = r.fields || {};
    return DATE_FIELDS_ORDERS.some(k => (typeof f[k] === 'string' && f[k] === date));
  });
}

async function searchInRequestLog(date, employeeID) {
  const resp = await atGet(TABLE.REQLOG, {
    filterByFormula: `{${FLD.RL_DATE}}='${date}'`,
    pageSize: 100,
  });
  const recs = resp.records || [];
  const matched = recs.find(r => {
    const f = r.fields || {};
    return Object.values(f).some(v => Array.isArray(v) && v.includes(employeeID));
  });
  const orderId = matched?.fields?.[FLD.RL_ORDER]?.[0] || null;
  return orderId;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });
  if (!BASE || !APIKEY)         return json(res, 500, { error: 'Missing AIRTABLE_* env' });

  try {
    const q = req.query || {};
    const orderId = q.orderId;

    if (orderId) {
      const summary = await fetchOrderSummaryById(orderId);
      if (!summary) return json(res, 404, { error: 'order not found' });
      return json(res, 200, { ok: true, summary });
    }

    const org = q.org; // пока не используем
    const employeeID = q.employeeID;
    const date = q.date;
    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    let foundOrders = [];
    for (const df of DATE_FIELDS_ORDERS) {
      try {
        const list = await searchOrdersByDateField(date, df);
        if (list && list.length) { foundOrders = list; break; }
      } catch {}
    }
    if (!foundOrders.length) foundOrders = await searchOrdersByDateAnyFieldJS(date);

    let candidate = foundOrders.find(r => {
      const f = r.fields || {};
      return Object.values(f).some(v => Array.isArray(v) && v.includes(employeeID));
    });

    if (!candidate) {
      const managers = foundOrders.filter(r =>
        Object.values(r.fields || {}).some(v => Array.isArray(v) && v.includes(employeeID)) &&
        String((r.fields || {})[FLD.ORDER_TYPE] || '').toLowerCase() === 'manager',
      );
      if (managers.length) candidate = managers[0];
    }

    if (!candidate) {
      const fromLog = await searchInRequestLog(date, employeeID);
      if (fromLog) {
        const summary = await fetchOrderSummaryById(fromLog);
        return json(res, 200, { ok: true, summary: summary || null });
      }
      return json(res, 200, { ok: true, summary: null });
    }

    const summary = await fetchOrderSummaryById(candidate.id);
    if (!summary) return json(res, 200, { ok: true, summary: null });

    // дополним boxes/extras/lines
    const full = await fetchOrderSummaryById(candidate.id); // (оставлено для совместимости кода выше)
    const mbResp = await atGet(TABLE.MEALBOXES, {
      filterByFormula: `FIND('${candidate.id}', ARRAYJOIN({Order}))`,
      "fields[]": ['Main (Menu Item)', 'Side (Menu Item)', 'Quantity'],
      pageSize: 100,
    });
    const olResp = await atGet(TABLE.ORDERLINES, {
      filterByFormula: `FIND('${candidate.id}', ARRAYJOIN({Order}))`,
      "fields[]": ['Item (Menu Item)', 'Quantity'],
      pageSize: 100,
    });

    const ids = new Set();
    (mbResp.records||[]).forEach(r => {
      const f = r.fields||{};
      (f['Main (Menu Item)']||[]).forEach(id=>ids.add(id));
      (f['Side (Menu Item)']||[]).forEach(id=>ids.add(id));
    });
    (olResp.records||[]).forEach(r => {
      const f=r.fields||{};
      (f['Item (Menu Item)']||[]).forEach(id=>ids.add(id));
    });
    const names={}, cats={};
    if (ids.size){
      const orList = Array.from(ids).map(id=>`RECORD_ID()='${id}'`).join(',');
      const m = await atGet(TABLE.MENU,{
        filterByFormula:`OR(${orList})`,
        "fields[]":['Name','Category','Extra Category','Dish Category','Menu Category'],
        pageSize:100
      });
      (m.records||[]).forEach(r=>{
        const f=r.fields||{};
        names[r.id]=f['Name']||r.id;
        cats[r.id]=f['Category']||f['Extra Category']||f['Dish Category']||f['Menu Category']||'';
      });
    }

    const boxes = (mbResp.records||[]).map(r=>{
      const f=r.fields||{};
      const mainId=(f['Main (Menu Item)']||[])[0]||null;
      const sideId=(f['Side (Menu Item)']||[])[0]||null;
      const qty=Math.max(0, Number(f['Quantity']||0));
      return { mainId, sideId, qty };
    });

    const extras = (olResp.records||[]).map(r=>{
      const f=r.fields||{};
      const itemId=(f['Item (Menu Item)']||[])[0]||null;
      const qty=Math.max(0, Number(f['Quantity']||0));
      return { itemId, qty, category: itemId ? (cats[itemId] || '') : '' };
    });

    const lines = [
      ...boxes.filter(b=>b.qty>0).map(b=>{
        const m=b.mainId? names[b.mainId] : '';
        const s=b.sideId? names[b.sideId] : '';
        return `${m || '—'}${s ? ' + ' + s : ''} × ${b.qty}`;
      }),
      ...extras.filter(e=>e.qty>0).map(e=>{
        const n=e.itemId? (names[e.itemId]||e.itemId) : '—';
        return `${n} × ${e.qty}`;
      }),
    ];

    return json(res, 200, { ok: true, summary: { ...summary, boxes, extras, lines } });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
