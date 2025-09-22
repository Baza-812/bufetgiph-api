// api/order.js — standalone версия без ./_lib/air.js

export const config = {
  runtime: 'nodejs18.x',
};

// ---- helpers ---------------------------------------------------

const ENV = (k, d) => process.env[k] ?? d;
const BASE = ENV('AIRTABLE_BASE_ID');
const API_KEY = ENV('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:     ENV('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  ENV('TBL_EMPLOYEES',  'Employees'),
  MENU:       ENV('TBL_MENU',       'Menu'),
  MEALBOXES:  ENV('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: ENV('TBL_ORDERLINES', 'Order Lines'),
};

const F = {
  EMP_ORG_LOOKUP: ENV('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      ENV('FLD_EMP_TOKEN', 'Order Token'),
  EMP_STATUS:     ENV('FLD_EMP_STATUS', 'Status'),

  ORDER_EMPLOYEE: ENV('FLD_ORDER_EMPLOYEE', 'Employee'),
  ORDER_MB_LINK:  ENV('FLD_ORDER_MB_LINK',  'Meal Boxes'),
  ORDER_OL_LINK:  ENV('FLD_ORDER_OL_LINK',  'Order Lines'),

  MB_ORDER: ENV('FLD_MB_ORDER', 'Order'),
  MB_MAIN:  ENV('FLD_MB_MAIN',  'Main (Menu Item)'),
  MB_SIDE:  ENV('FLD_MB_SIDE',  'Side (Menu Item)'),
  MB_QTY:   ENV('FLD_MB_QTY',   'Quantity'),
  MB_TYPE:  ENV('FLD_MB_TYPE',  'Line Type'),

  OL_ORDER: ENV('FLD_OL_ORDER', 'Order'),
  OL_ITEM:  ENV('FLD_OL_ITEM',  'Item (Menu Item)'),
  OL_QTY:   ENV('FLD_OL_QTY',   'Quantity'),
  OL_TYPE:  ENV('FLD_OL_TYPE',  'Line Type'),
};

const json = (res, code, data) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
};

const atHeaders = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

const atUrl = (table) =>
  `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`;

async function atGet(table, params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((vv) => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const url = `${atUrl(table)}?${usp.toString()}`;
  const r = await fetch(url, { headers: atHeaders });
  if (!r.ok) throw new Error(`AT GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPost(table, body) {
  const r = await fetch(atUrl(table), {
    method: 'POST',
    headers: atHeaders,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`AT POST ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPatch(table, body) {
  const r = await fetch(atUrl(table), {
    method: 'PATCH',
    headers: atHeaders,
    body: JSON.stringify(body),
  });
  if (!r.ok)
    throw new Error(`AT PATCH ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

// ---- core -------------------------------------------------------

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  if (req.method !== 'POST')
    return json(res, 405, { error: 'POST only' });

  try {
    if (!API_KEY || !BASE)
      return json(res, 500, { error: 'Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID' });

    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { employeeID, org, token, date, included } = body;

    if (!employeeID || !org || !token || !date) {
      return json(res, 400, { error: 'employeeID, org, token, date are required' });
    }

    // 1) Сотрудник + проверки
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS],
      maxRecords: 1,
    });
    const emp = one(empResp.records);
    if (!emp) return json(res, 404, { error: 'employee not found' });

    const ef = emp.fields || {};
    const empOrg =
      (Array.isArray(ef[F.EMP_ORG_LOOKUP]) ? ef[F.EMP_ORG_LOOKUP][0] : ef[F.EMP_ORG_LOOKUP]) || null;
    if (empOrg !== org) return json(res, 403, { error: 'employee not allowed (org mismatch)' });

    const empToken = ef[F.EMP_TOKEN];
    if (!empToken || empToken !== token) return json(res, 403, { error: 'invalid token' });

    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase() !== 'active') {
      return json(res, 403, { error: 'employee not active' });
    }

    // 2) Дата доступна в Menu?
    const menuResp = await atGet(TABLE.MENU, {
      filterByFormula: `IS_SAME({Date}, DATETIME_PARSE('${date}'), 'day')`,
      'fields[]': ['Date'],
      maxRecords: 1,
    });
    if (!menuResp.records?.length)
      return json(res, 400, { error: 'date is not available for this org' });

    // 3) Создаём заказ (линкуем Employee)
    const orderFields = {
      'Order Date': date,
      'Order Type': 'Employee',
      [F.ORDER_EMPLOYEE]: [emp.id], // <= ключевое
    };
    const orderCreate = await atPost(TABLE.ORDERS, {
      typecast: true,
      records: [{ fields: orderFields }],
    });
    const orderRec = one(orderCreate.records);
    if (!orderRec) return json(res, 500, { error: 'order create failed' });
    const orderId = orderRec.id;

    const ids = { mealBoxes: [], orderLines: [] };
    const writeLog = {};

    // 4) Meal Box
    if (included?.mainId || included?.sideId) {
      const mbFields = {
        [F.MB_ORDER]: [orderId],
        [F.MB_QTY]: 1,
        [F.MB_TYPE]: 'Included',
      };
      if (included.mainId) mbFields[F.MB_MAIN] = [{ id: included.mainId }];
      if (included.sideId) mbFields[F.MB_SIDE] = [{ id: included.sideId }];

      const mbResp = await atPost(TABLE.MEALBOXES, {
        typecast: true,
        records: [{ fields: mbFields }],
      });
      (mbResp.records || []).forEach((r) => ids.mealBoxes.push(r.id));
      writeLog.mb_main = { ok: [F.MB_MAIN] };
      if (included.sideId) writeLog.mb_side = { ok: [F.MB_SIDE] };
    }

    // 5) Order Lines (extras)
    const extras = Array.isArray(included?.extras)
      ? included.extras.slice(0, 2)
      : [];
    if (extras.length) {
      const olCreate = await atPost(TABLE.ORDERLINES, {
        typecast: true,
        records: extras.map((itemId) => ({
          fields: {
            [F.OL_ORDER]: [orderId],
            [F.OL_ITEM]: [{ id: itemId }],
            [F.OL_QTY]: 1,
            [F.OL_TYPE]: 'Included',
          },
        })),
      });
      (olCreate.records || []).forEach((r) => ids.orderLines.push(r.id));
      writeLog.ol_item = { ok: [F.OL_ITEM] };
    }

    // 6) Патчим заказ обратными ссылками
    const patchFields = {};
    if (ids.mealBoxes.length) patchFields[F.ORDER_MB_LINK] = ids.mealBoxes;
    if (ids.orderLines.length) patchFields[F.ORDER_OL_LINK] = ids.orderLines;
    if (Object.keys(patchFields).length) {
      await atPatch(TABLE.ORDERS, {
        typecast: true,
        records: [{ id: orderId, fields: patchFields }],
      });
    }

    // 7) Read-back
    const readOrder = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      'fields[]': [F.ORDER_EMPLOYEE, F.ORDER_MB_LINK, F.ORDER_OL_LINK, 'Order Date', 'Order Type'],
      maxRecords: 1,
    });
    const rbOrder = one(readOrder.records) || null;

    const rbMB = ids.mealBoxes.length
      ? await atGet(TABLE.MEALBOXES, {
          filterByFormula: `OR(${ids.mealBoxes.map((id) => `RECORD_ID()='${id}'`).join(',')})`,
        })
      : { records: [] };

    const rbOL = ids.orderLines.length
      ? await atGet(TABLE.ORDERLINES, {
          filterByFormula: `OR(${ids.orderLines.map((id) => `RECORD_ID()='${id}'`).join(',')})`,
        })
      : { records: [] };

    return json(res, 200, {
      ok: true,
      orderId,
      ids,
      writeLog,
      readBack: {
        order: rbOrder,
        mealBoxes: rbMB.records || [],
        orderLines: rbOL.records || [],
      },
    });
  } catch (e) {
    console.error('order.js error:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
}
