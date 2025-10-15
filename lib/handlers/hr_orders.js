// /lib/handlers/hr_orders.js
// Модалка сотрудника (mode=single) и список для HR (mode=list) + устойчивое сравнение по дате

const { json, withRateLimit, atGet, one, TABLE } = require('../utils');

// ===== Таблицы
const TBL_ORDERS     = TABLE.ORDERS     || 'Orders';
const TBL_EMPLOYEES  = TABLE.EMPLOYEES  || 'Employees';
const TBL_ORGS       = TABLE.ORGS       || 'Organizations';
const TBL_MB         = TABLE.MEALBOXES  || 'Meal Boxes';
const TBL_OL         = TABLE.ORDERLINES || 'Order Lines';
const TBL_REQLOG     = TABLE.REQLOG     || 'Request Log';

// ===== Employees
const EMP_FULLNAME   = 'FullName';
const EMP_ORG_LOOKUP = 'OrgID (from Organization)';
const EMP_TOKEN      = 'Order Token';
const EMP_STATUS     = 'Status';
const EMP_ROLE       = 'Role';

// ===== Orders
const ORD_DATE_ISO   = 'OrderDateISO';     // текстовое ISO YYYY-MM-DD (может быть пусто у старых заказов)
const ORD_DATE_DT    = 'Order Date';       // поле типа Date
const ORD_TYPE       = 'Order Type';       // 'Employee' | 'Manager' | пусто
const ORD_EMP        = 'Employee';         // link -> Employees
const ORD_ORG        = 'Org';              // link -> Organizations (recordId)
const ORD_ORG_IDS    = 'Org IDs';          // если есть — текст/мультиселект с кодами
const ORD_STATUS     = 'Status';
const ORD_MB_LINK    = 'Meal Boxes';
const ORD_OL_LINK    = 'Order Lines';
const ORD_MAIN_TXT   = 'Main';
const ORD_SIDE_TXT   = 'Side';
const ORD_EXTRA_TXT  = 'Extra';

// ===== Meal Boxes
const MB_MAIN_NAME   = 'Main Name';
const MB_SIDE_NAME   = 'Side Name';
const MB_QTY         = 'Quantity';

// ===== Order Lines
const OL_ITEM_NAME   = 'Item Name';
const OL_QTY         = 'Quantity';

// ===== Orgs
const ORG_CODE       = 'OrgID';

// ===== Request Log
const RL_DATE        = 'Date';
const RL_EMP         = 'Employee';
const RL_ORDER       = 'Order';

// ===== Утилиты
const lower = (s) => String(s || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled' || s === 'deleted';
};
const eqStr = (field, val) => `{${field}}='${String(val).replace(/'/g, "\\'")}'`;
const containsStr = (field, val) => `FIND('${String(val).replace(/'/g, "\\'")}', {${field}})`;

// Условие по дате: либо текстовое OrderDateISO, либо дата из Order Date, отформатированная в YYYY-MM-DD
const dateCondOrders = (dateISO) =>
  `OR({${ORD_DATE_ISO}}='${dateISO}', DATETIME_FORMAT({${ORD_DATE_DT}}, 'YYYY-MM-DD')='${dateISO}')`;

// Для Request Log: дата могла быть текстом или датой
const dateCondReqLog = (dateISO) =>
  `OR({${RL_DATE}}='${dateISO}', DATETIME_FORMAT({${RL_DATE}}, 'YYYY-MM-DD')='${dateISO}')`;

async function getOrgRecIdByCode(orgCode) {
  const r = await atGet(TBL_ORGS, {
    filterByFormula: eqStr(ORG_CODE, orgCode),
    "fields[]": [],
    maxRecords: 1, pageSize: 1
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

async function getEmployee(empId, fields = []) {
  const r = await atGet(TBL_EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${empId}'`,
    "fields[]": fields,
    maxRecords: 1, pageSize: 1
  });
  return one(r.records);
}

function composeBoxFromOrderFields(f = {}) {
  const main = (f[ORD_MAIN_TXT] || '').toString().trim();
  const side = (f[ORD_SIDE_TXT] || '').toString().trim();
  if (main && side) return `${main} + ${side}`;
  if (main) return main;
  if (side) return side;
  return '';
}

async function composeBoxFromMealBoxes(linkIds) {
  if (!Array.isArray(linkIds) || !linkIds.length) return '';
  const or = `OR(${linkIds.map(id => `RECORD_ID()='${id}'`).join(',')})`;
  const r = await atGet(TBL_MB, {
    filterByFormula: or,
    "fields[]": [MB_MAIN_NAME, MB_SIDE_NAME, MB_QTY],
    pageSize: 50
  });
  const rec = one(r.records);
  if (!rec) return '';
  const f = rec.fields || {};
  const main = (f[MB_MAIN_NAME] || '').toString().trim();
  const side = (f[MB_SIDE_NAME] || '').toString().trim();
  if (main && side) return `${main} + ${side}`;
  if (main) return main;
  if (side) return side;
  return '';
}

async function pickExtras(f = {}) {
  const extraTxt = (f[ORD_EXTRA_TXT] || '').toString();
  if (extraTxt) {
    const parts = extraTxt.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    return [parts[0] || '', parts[1] || ''];
  }
  const ids = Array.isArray(f[ORD_OL_LINK]) ? f[ORD_OL_LINK] : [];
  if (!ids.length) return ['', ''];
  const or = `OR(${ids.map(id => `RECORD_ID()='${id}'`).join(',')})`;
  const r = await atGet(TBL_OL, {
    filterByFormula: or,
    "fields[]": [OL_ITEM_NAME, OL_QTY],
    pageSize: 50
  });
  const lines = (r.records || []).map(x => (x.fields || {})[OL_ITEM_NAME]).filter(Boolean);
  return [lines[0] || '', lines[1] || ''];
}

// Поиск одного заказа сотрудника на дату с серией попыток + fallback по Request Log
async function findOrder(dateISO, orgRecId, orgCode, employeeId) {
  const tried = [];
  const typeCond = `OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee')`;
  const notCancelled = `NOT(OR(LOWER({${ORD_STATUS}})='cancelled',LOWER({${ORD_STATUS}})='canceled',LOWER({${ORD_STATUS}})='deleted'))`;
  const empCond = `{${ORD_EMP}}='${employeeId}'`;
  const dCond = dateCondOrders(dateISO);

  // 1) строгий: дата + employee + org (link)
  {
    const orgIdsCond = `OR(
  ${eqStr(ORD_ORG_IDS, orgRecId)},
  FIND('${orgRecId}', {${ORD_ORG_IDS}}),
  FIND('${orgRecId}', ARRAYJOIN({${ORD_ORG_IDS}}))
)`;
const filter = `AND(${dCond}, ${empCond}, ${notCancelled}, ${typeCond}, ${orgIdsCond})`;
    tried.push({ step: 'orders: date+emp+orgLink', filter });
    const r = await atGet(TBL_ORDERS, {
      filterByFormula: filter,
      "fields[]": [ORD_STATUS, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK, ORD_ORG, ORD_EMP],
      maxRecords: 1, pageSize: 1
    });
    if (r.records?.length) return { record: r.records[0], tried };
  }

  // 2) если есть Org IDs: дата + employee + Org IDs содержит код
  try {
    const filter = `AND(${dCond}, ${empCond}, ${notCancelled}, ${typeCond}, OR(${eqStr(ORD_ORG_IDS, orgCode)}, ${containsStr(ORD_ORG_IDS, orgCode)}))`;
    tried.push({ step: 'orders: date+emp+orgIDs', filter });
    const r = await atGet(TBL_ORDERS, {
      filterByFormula: filter,
      "fields[]": [ORD_STATUS, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK, ORD_ORG, ORD_EMP],
      maxRecords: 1, pageSize: 1
    });
    if (r.records?.length) return { record: r.records[0], tried };
  } catch { /* поля может не быть — ок */ }

  // 3) мягкий: дата + employee (без org)
  {
    const filter = `AND(${dCond}, ${empCond}, ${notCancelled}, ${typeCond})`;
    tried.push({ step: 'orders: date+emp (no org)', filter });
    const r = await atGet(TBL_ORDERS, {
      filterByFormula: filter,
      "fields[]": [ORD_STATUS, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK, ORD_ORG, ORD_EMP],
      maxRecords: 1, pageSize: 1
    });
    if (r.records?.length) return { record: r.records[0], tried };
  }

  // 3b) сверх-мягкий: дата + employee (без org и без Order Type)
{
  const filter = `AND(${dCond}, ${empCond}, ${notCancelled})`;
  tried.push({ step: 'orders: date+emp (no org, no type)', filter });
  const r = await atGet(TBL_ORDERS, {
    filterByFormula: filter,
    "fields[]": [ORD_STATUS, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK, ORD_ORG, ORD_EMP],
    maxRecords: 1, pageSize: 1
  });
  if (r.records?.length) return { record: r.records[0], tried };
}

  // 4) fallback через Request Log: {Date}≈дата & {Employee}=сотрудник
  try {
    const rlFilter = `AND(${dateCondReqLog(dateISO)}, ${eqStr(RL_EMP, employeeId)})`;
    tried.push({ step: 'request_log: date+employee', filter: rlFilter });
    const rl = await atGet(TBL_REQLOG, {
      filterByFormula: rlFilter,
      "fields[]": [RL_ORDER],
      maxRecords: 1, pageSize: 1
    });
    const rec = one(rl.records);
    const orderId = rec?.fields?.[RL_ORDER]?.[0];
    if (orderId) {
      const o = await atGet(TBL_ORDERS, {
        filterByFormula: `RECORD_ID()='${orderId}'`,
        "fields[]": [ORD_STATUS, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK, ORD_ORG, ORD_EMP],
        maxRecords: 1, pageSize: 1
      });
      if (o.records?.length) return { record: o.records[0], tried };
    }
  } catch { /* если таблицы нет — тоже ок */ }

  return { record: null, tried };
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url   = new URL(req.url, `http://${req.headers.host}`);
  const mode  = (url.searchParams.get('mode') || 'list').toLowerCase();

  const requesterID = url.searchParams.get('employeeID');
  const orgCode     = url.searchParams.get('org');
  const token       = url.searchParams.get('token');
  const dateISO     = url.searchParams.get('date');
  const forEmpID    = url.searchParams.get('forEmployeeID') || requesterID;

  if (!requesterID || !orgCode || !token || !dateISO) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // Валидируем вызывающего
  const who = await getEmployee(requesterID, [EMP_ORG_LOOKUP, EMP_TOKEN, EMP_STATUS, EMP_ROLE, EMP_FULLNAME]);
  if (!who) return json(res, 404, { error: 'employee not found' });

  const whoOrg = Array.isArray(who.fields?.[EMP_ORG_LOOKUP]) ? who.fields[EMP_ORG_LOOKUP][0] : who.fields?.[EMP_ORG_LOOKUP];
  if (!whoOrg) return json(res, 400, { error: 'employee org missing' });
  if (who.fields?.[EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  if (isCancelled(who.fields?.[EMP_STATUS])) return json(res, 403, { error: 'employee not active' });

  const isHR = String(who.fields?.[EMP_ROLE] || '').toUpperCase().includes('HR');

  // Org recordId
  const orgRecId = await getOrgRecIdByCode(orgCode);
  if (!orgRecId) return json(res, 400, { error: 'organization not found' });

  // ===== LIST (HR)
  if (mode === 'list') {
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    const filter = `AND(
      ${dateCondOrders(dateISO)},
      OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee'),
      NOT(OR(LOWER({${ORD_STATUS}})='cancelled',LOWER({${ORD_STATUS}})='canceled',LOWER({${ORD_STATUS}})='deleted')),
      {${ORD_ORG}}='${orgRecId}'
    )`;

    const r = await atGet(TBL_ORDERS, {
      filterByFormula: filter,
      "fields[]": [ORD_EMP, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK],
      pageSize: 100
    });
    const orders = r.records || [];

    // подтянем ФИО
    const empIds = Array.from(new Set(orders.flatMap(o => o.fields?.[ORD_EMP] || [])));
    const empMap = new Map();
    for (let i=0; i<empIds.length; i+=50) {
      const chunk = empIds.slice(i, i+50);
      const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const er = await atGet(TBL_EMPLOYEES, { filterByFormula: or, "fields[]": [EMP_FULLNAME], pageSize: 50 });
      (er.records || []).forEach(rec => empMap.set(rec.id, rec.fields?.[EMP_FULLNAME] || ''));
    }

    const items = [];
    for (const o of orders) {
      const empId = Array.isArray(o.fields?.[ORD_EMP]) ? o.fields[ORD_EMP][0] : o.fields?.[ORD_EMP];
      if (!empId) continue;
      let mealBox = composeBoxFromOrderFields(o.fields);
      if (!mealBox) mealBox = await composeBoxFromMealBoxes(o.fields?.[ORD_MB_LINK]);
      const [e1, e2] = await pickExtras(o.fields);
      items.push({
        employeeId: empId,
        fullName: empMap.get(empId) || '',
        date: dateISO,
        orderId: o.id,
        mealBox,
        extra1: e1,
        extra2: e2
      });
    }
    items.sort((a,b)=> (a.fullName||'').localeCompare(b.fullName||'','ru'));
    return json(res, 200, { ok: true, items });
  }

  // ===== SINGLE (модалка сотрудника)
  if (forEmpID !== requesterID && !isHR) {
    return json(res, 403, { error: 'only HR can query for other employee' });
  }

  let targetName = who.fields?.[EMP_FULLNAME] || '';
  if (forEmpID !== requesterID) {
    const te = await getEmployee(forEmpID, [EMP_FULLNAME, EMP_ORG_LOOKUP]);
    if (!te) return json(res, 404, { error: 'target employee not found' });
    targetName = te.fields?.[EMP_FULLNAME] || '';
  }

  const found = await findOrder(dateISO, orgRecId, orgCode, forEmpID);
  const order = found.record;

  if (!order) {
    return json(res, 200, { ok: true, summary: null, diag: found.tried });
  }

  let mealBox = composeBoxFromOrderFields(order.fields);
  if (!mealBox) mealBox = await composeBoxFromMealBoxes(order.fields?.[ORD_MB_LINK]);
  const [extra1, extra2] = await pickExtras(order.fields);

  return json(res, 200, {
    ok: true,
    summary: {
      fullName: targetName,
      date:     dateISO,
      mealBox,
      extra1,
      extra2,
      orderId:  order.id
    }
  });
}, { windowMs: 4000, max: 15 });
