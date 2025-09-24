// api/order.js — CommonJS, прямой REST к Airtable, ссылки на меню = ["rec..."]

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  MENU:       env('TBL_MENU',       'Menu'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
};

const F = {
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),

  ORDER_EMPLOYEE: env('FLD_ORDER_EMPLOYEE', 'Employee'),
  ORDER_MB_LINK:  env('FLD_ORDER_MB_LINK',  'Meal Boxes'),
  ORDER_OL_LINK:  env('FLD_ORDER_OL_LINK',  'Order Lines'),

  MB_ORDER: env('FLD_MB_ORDER', 'Order'),
  MB_MAIN:  env('FLD_MB_MAIN',  'Main (Menu Item)'),
  MB_SIDE:  env('FLD_MB_SIDE',  'Side (Menu Item)'),
  MB_QTY:   env('FLD_MB_QTY',   'Quantity'),
  MB_TYPE:  env('FLD_MB_TYPE',  'Line Type'),

  OL_ORDER: env('FLD_OL_ORDER', 'Order'),
  OL_ITEM:  env('FLD_OL_ITEM',  'Item (Menu Item)'),
  OL_QTY:   env('FLD_OL_QTY',   'Quantity'),
  OL_TYPE:  env('FLD_OL_TYPE',  'Line Type'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}
const atHeaders = () => ({
  Authorization: `Bearer ${APIKEY}`,
  'Content-Type': 'application/json',
});
const atUrl = (table) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`;

async function atGet(table, params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((vv) => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  }
  const r = await fetch(`${atUrl(table)}?${usp.toString()}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function atPost(table, body) {
  const r = await fetch(atUrl(table), { method: 'POST', headers: atHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT POST ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function atPatch(table, body) {
  const r = await fetch(atUrl(table), { method: 'PATCH', headers: atHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
const one = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readRawBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let data=''; req.on('data', c => data+=c);
    req.on('end', () => { try { resolve(data?JSON.parse(data):{}); } catch { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST')   return json(res, 405, { error: 'POST only' });
    if (!BASE || !APIKEY)        return json(res, 500, { error: 'Missing AIRTABLE_BASE_ID or AIRTABLE_API_KEY' });

    const body = await readRawBody(req);
    const { employeeID, org, token, date, included } = body || {};
    if (!employeeID || !org || !token || !date) {
      return json(res, 400, { error: 'employeeID, org, token, date are required' });
    }

    // 1) Сотрудник и проверки
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS],
      maxRecords: 1,
    });
    const emp = one(empResp.records);
    if (!emp) return json(res, 404, { error: 'employee not found' });

    const ef = emp.fields || {};
    const empOrg = (Array.isArray(ef[F.EMP_ORG_LOOKUP]) ? ef[F.EMP_ORG_LOOKUP][0] : ef[F.EMP_ORG_LOOKUP]) || null;
    if (empOrg !== org) return json(res, 403, { error: 'employee not allowed (org mismatch)' });
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase() !== 'active') {
      return json(res, 403, { error: 'employee not active' });
    }

    // 2) Дата доступна (есть хоть одна позиция на день)
    const menuResp = await atGet(TABLE.MENU, {
      filterByFormula: `IS_SAME({Date}, DATETIME_PARSE('${date}'), 'day')`,
      'fields[]': ['Date'],
      maxRecords: 1,
    });
    if (!menuResp.records?.length) return json(res, 400, { error: 'date is not available for this org' });

    // 3) Создаём заказ и сразу линкуем Employee
    const orderCreate = await atPost(TABLE.ORDERS, {
      typecast: true,
      records: [{
        fields: {
          'Order Date': date,
          'Order Type': 'Employee',
          [F.ORDER_EMPLOYEE]: [emp.id], // ключевое
        },
      }],
    });
    const orderRec = one(orderCreate.records);
    if (!orderRec) return json(res, 500, { error: 'order create failed' });
    const orderId = orderRec.id;

    const ids = { mealBoxes: [], orderLines: [] };
    const writeLog = { mb_main: {}, mb_side: {}, ol_item: {} };

    // 4) Meal Box — пишем ссылки на меню МАССИВАМИ СТРОК
    if (included?.mainId || included?.sideId) {
      const mbFields = {
        [F.MB_ORDER]: [orderId],
        [F.MB_QTY]: 1,
        [F.MB_TYPE]: 'Included',
      };
      if (included.mainId) mbFields[F.MB_MAIN] = [ included.mainId ];
      if (included.sideId) mbFields[F.MB_SIDE] = [ included.sideId ];

      const mbResp = await atPost(TABLE.MEALBOXES, { typecast: true, records: [{ fields: mbFields }] });
      (mbResp.records || []).forEach((r) => ids.mealBoxes.push(r.id));
      writeLog.mb_main.ok = [F.MB_MAIN];
      if (included.sideId) writeLog.mb_side.ok = [F.MB_SIDE];
    }

    // 5) Extras → Order Lines — ссылки на меню тоже МАССИВАМИ СТРОК
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0, 2) : [];
    if (extras.length) {
      const olResp = await atPost(TABLE.ORDERLINES, {
        typecast: true,
        records: extras.map((itemId) => ({
          fields: {
            [F.OL_ORDER]: [orderId],
            [F.OL_ITEM]: [ itemId ],
            [F.OL_QTY]: 1,
            [F.OL_TYPE]: 'Included',
          },
        })),
      });
      (olResp.records || []).forEach((r) => ids.orderLines.push(r.id));
      writeLog.ol_item.ok = [F.OL_ITEM];
    }

    // 6) Патчим обратные ссылки в Order
    const patchFields = {};
    if (ids.mealBoxes.length)  patchFields[F.ORDER_MB_LINK] = ids.mealBoxes;
    if (ids.orderLines.length) patchFields[F.ORDER_OL_LINK] = ids.orderLines;
    if (Object.keys(patchFields).length) {
      await atPatch(TABLE.ORDERS, { typecast: true, records: [{ id: orderId, fields: patchFields }] });
    }

    // 7) Read-back (дать Airtable применить линк)
    await sleep(200);
    const rbOrder = one(
      (await atGet(TABLE.ORDERS, {
        filterByFormula: `RECORD_ID()='${orderId}'`,
        'fields[]': [F.ORDER_EMPLOYEE, F.ORDER_MB_LINK, F.ORDER_OL_LINK, 'Order Date', 'Order Type'],
        maxRecords: 1,
      })).records
    );
    const rbMB = ids.mealBoxes.length
      ? await atGet(TABLE.MEALBOXES, { filterByFormula: `OR(${ids.mealBoxes.map(id => `RECORD_ID()='${id}'`).join(',')})` })
      : { records: [] };
    const rbOL = ids.orderLines.length
      ? await atGet(TABLE.ORDERLINES, { filterByFormula: `OR(${ids.orderLines.map(id => `RECORD_ID()='${id}'`).join(',')})` })
      : { records: [] };

    return json(res, 200, {
      ok: true,
      orderId,
      ids,
      writeLog,
      readBack: { order: rbOrder, mealBoxes: rbMB.records || [], orderLines: rbOL.records || [] },
    });
  } catch (e) {
    console.error('order.js failed:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
