// /api/order_summary.js
// Короткий handler для модалки "состав заказа" (и подсветки дат).
// Делает одну вещь: найти активный заказ на дату и вернуть красивые строки:
//  - "Main Name + Side Name × qty" для Meal Boxes
//  - "Item Name × qty"          для допов (Order Lines)

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
};

const F = {
  // Orders
  ORDER_DATE:    env('FLD_ORDER_DATE',   'Order Date'),
  ORDER_STATUS:  env('FLD_ORDER_STATUS', 'Status'),
  ORDER_EMP:     env('FLD_ORDER_EMP',    'Employee'),
  ORDER_MB:      env('FLD_ORDER_MB',     'Meal Boxes'),
  ORDER_OL:      env('FLD_ORDER_OL',     'Order Lines'),
  ORDER_ORG:     env('FLD_ORDER_ORG',    'Org'),
  ORDER_TYPE:    env('FLD_ORDER_TYPE',   'Order Type'),
  ORDER_DATE_ISO:env('FLD_ORDER_DATE_ISO','OrderDateISO'), // у вас это поле есть

  // Meal Boxes
  MB_QTY:        env('FLD_MB_QTY',       'Quantity'),
  MB_MAIN_NAME:  env('FLD_MB_MAIN_NAME', 'Main Name'),
  MB_SIDE_NAME:  env('FLD_MB_SIDE_NAME', 'Side Name'),

  // Order Lines
  OL_QTY:        env('FLD_OL_QTY',       'Quantity'),
  OL_ITEM_NAME:  env('FLD_OL_ITEM_NAME', 'Item Name'),

  // Employees
  EMP_ORG_LOOKUP:env('FLD_EMP_ORG_LOOKUP','OrgID (from Organization)'),
  EMP_TOKEN:     env('FLD_EMP_TOKEN',     'Order Token'),
  EMP_STATUS:    env('FLD_EMP_STATUS',    'Status'),

  // Orgs
  ORG_ID:        env('FLD_ORG_ID',       'OrgID'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

const atHeaders = () => ({ Authorization:`Bearer ${APIKEY}` });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(t, params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{
    if (Array.isArray(v)) v.forEach(vv=>usp.append(k,vv));
    else if (v!=null) usp.append(k,v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

// Активный заказ: дата + орг + не отменённый + тип не задан ИЛИ Manager/Employee
function activeOrderFilter({ dateISO, orgRecId }) {
  // исключаем cancelled/canceled
  const notCancelled = `NOT(OR(LOWER({${F.ORDER_STATUS}})='cancelled',LOWER({${F.ORDER_STATUS}})='canceled'))`;
  // тип
  const okType = `OR(LEN({${F.ORDER_TYPE}})=0, LOWER({${F.ORDER_TYPE}})='manager', LOWER({${F.ORDER_TYPE}})='employee')`;
  // дата (используем OrderDateISO) + организация (поле-ссылка Org -> RECORD_ID)
  return `AND({${F.ORDER_DATE_ISO}}='${dateISO}', {${F.ORDER_ORG}}='${orgRecId}', ${notCancelled}, ${okType})`;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    if (!BASE || !APIKEY) return json(res, 500, { error: 'Missing AIRTABLE_* env' });

    const { org, employeeID, token, date, debug } = req.query || {};
    if (!org || !employeeID || !token || !date)
      return json(res, 400, { error: 'org, employeeID, token, date required' });

    // 1) проверим сотрудника и совпадение org
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      "fields[]": [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS],
      maxRecords: 1,
      pageSize: 1,
    });
    const emp = one(empResp.records);
    if (!emp) return json(res, 404, { error: 'employee not found' });
    const empOrg = Array.isArray(emp.fields?.[F.EMP_ORG_LOOKUP])
      ? emp.fields[F.EMP_ORG_LOOKUP][0]
      : emp.fields?.[F.EMP_ORG_LOOKUP];
    if (!empOrg) return json(res, 400, { error: 'employee org missing' });
    if (emp.fields?.[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });

    // найдём реальный recId для организации из Orders.Org
    // (у вас в Orders поле Org — это ссылка на Organizations)
    // Проверим, что код org совпадает
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      "fields[]": [],
      maxRecords: 1,
      pageSize: 1,
    });
    const orgRec = one(orgResp.records);
    if (!orgRec) return json(res, 400, { error: 'organization not found' });

    // 2) ищем активный заказ на дату
    const filter = activeOrderFilter({ dateISO: date, orgRecId: orgRec.id });
    const ordResp = await atGet(TABLE.ORDERS, {
      filterByFormula: filter,
      "fields[]": [F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_MB, F.ORDER_OL],
      maxRecords: 1,
      pageSize: 1,
    });
    const order = one(ordResp.records);
    if (!order) {
      return json(res, 200, { ok: true, summary: null, diag: debug ? { filter } : undefined });
    }

    const orderId = order.id;
    const status  = order.fields?.[F.ORDER_STATUS] || '';
    const dateIso = String(order.fields?.[F.ORDER_DATE] || '').substring(0,10);

    // 3) подтягиваем Meal Boxes
    const mbIds = Array.isArray(order.fields?.[F.ORDER_MB]) ? order.fields[F.ORDER_MB] : [];
    let mbRecords = [];
    if (mbIds.length) {
      const filterOR = `OR(${mbIds.map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const mbResp = await atGet(TABLE.MEALBOXES, {
        filterByFormula: filterOR,
        "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME, F.MB_QTY],
        pageSize: 100,
      });
      mbRecords = mbResp.records || [];
    }

    // 4) подтягиваем Order Lines
    const olIds = Array.isArray(order.fields?.[F.ORDER_OL]) ? order.fields[F.ORDER_OL] : [];
    let olRecords = [];
    if (olIds.length) {
      const filterOR = `OR(${olIds.map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const olResp = await atGet(TABLE.ORDERLINES, {
        filterByFormula: filterOR,
        "fields[]": [F.OL_ITEM_NAME, F.OL_QTY],
        pageSize: 100,
      });
      olRecords = olResp.records || [];
    }

    // 5) собираем красивые строки
    const items = [];

    for (const r of mbRecords) {
      const f = r.fields || {};
      const main = f[F.MB_MAIN_NAME] || '';
      const side = f[F.MB_SIDE_NAME] || '';
      const qty  = Math.max(0, +f[F.MB_QTY] || 0);
      if (!qty) continue;

      const left  = main ? String(main) : '';
      const right = side ? ` + ${String(side)}` : '';
      items.push(`${left}${right} × ${qty}`);
    }

    for (const r of olRecords) {
      const f = r.fields || {};
      const name = f[F.OL_ITEM_NAME] || '';
      const qty  = Math.max(0, +f[F.OL_QTY] || 0);
      if (!name || !qty) continue;
      items.push(`${String(name)} × ${qty}`);
    }

    return json(res, 200, {
      ok: true,
      summary: {
        orderId,
        date: dateIso,
        status,
        items,               // готовые строки для отображения
      },
      diag: debug ? { filter, mb: mbIds.length, ol: olIds.length } : undefined,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
