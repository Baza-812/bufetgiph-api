// /lib/handlers/hr_orders.js
// HR/orders: mode=list (сводка на дату) и mode=single (карточка сотрудника для модалки)
// Привязано к фактической схеме Airtable из "Структура Airtable.txt".

const { json, withRateLimit, atGet, one, TABLE } = require('../utils');

// ==== Таблицы
const TBL_ORDERS     = TABLE.ORDERS     || 'Orders';
const TBL_EMPLOYEES  = TABLE.EMPLOYEES  || 'Employees';
const TBL_ORGS       = TABLE.ORGS       || 'Organizations';
const TBL_MB         = TABLE.MEALBOXES  || 'Meal Boxes';
const TBL_OL         = TABLE.ORDERLINES || 'Order Lines';

// ==== Поля Employees
const EMP_FULLNAME   = 'FullName';
const EMP_ORG_LOOKUP = 'OrgID (from Organization)';
const EMP_TOKEN      = 'Order Token';
const EMP_STATUS     = 'Status';
const EMP_ROLE       = 'Role';

// ==== Поля Orders
const ORD_NO         = 'Order No';
const ORD_DATE       = 'Order Date';
const ORD_DATE_ISO   = 'OrderDateISO';
const ORD_TYPE       = 'Order Type';     // 'Employee' | 'Manager'
const ORD_EMP        = 'Employee';       // link -> Employees
const ORD_ORG        = 'Org';            // link -> Organizations (recordId)
const ORD_STATUS     = 'Status';
const ORD_MB_LINK    = 'Meal Boxes';     // link -> Meal Boxes
const ORD_OL_LINK    = 'Order Lines';    // link -> Order Lines
const ORD_MAIN_TXT   = 'Main';           // текст (если есть)
const ORD_SIDE_TXT   = 'Side';           // текст (если есть)
const ORD_EXTRA_TXT  = 'Extra';          // текст, иногда агрегированный

// ==== Поля Meal Boxes
const MB_MAIN_NAME   = 'Main Name';
const MB_SIDE_NAME   = 'Side Name';
const MB_QTY         = 'Quantity';

// ==== Поля Order Lines
const OL_ITEM_NAME   = 'Item Name';
const OL_QTY         = 'Quantity';

// ==== Поля Orgs
const ORG_CODE       = 'OrgID';

// ==== Утилиты
const lower = (s) => String(s || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled' || s === 'deleted';
};

function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

async function getEmployee(empId, fields = []) {
  const r = await atGet(TBL_EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${empId}'`,
    "fields[]": fields,
    maxRecords: 1,
    pageSize: 1
  });
  return one(r.records);
}

async function getOrgRecIdByCode(orgCode) {
  const r = await atGet(TBL_ORGS, {
    filterByFormula: eqStr(ORG_CODE, orgCode),
    "fields[]": [],
    maxRecords: 1,
    pageSize: 1
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

function composeBoxFromOrderFields(f) {
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

async function pickExtras(f) {
  // 1) если в Orders есть агрегированное текстовое поле Extra — делим по запятой
  const extraTxt = (f[ORD_EXTRA_TXT] || '').toString();
  if (extraTxt) {
    const parts = extraTxt.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    return [parts[0] || '', parts[1] || ''];
  }
  // 2) иначе — берём первые две строки Order Lines по Item Name
  const link = f[ORD_OL_LINK];
  const ids = Array.isArray(link) ? link : [];
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

// ===== Handler
module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = (url.searchParams.get('mode') || 'list').toLowerCase();

  const requesterID = url.searchParams.get('employeeID');
  const orgCode     = url.searchParams.get('org');
  const token       = url.searchParams.get('token');
  const dateISO     = url.searchParams.get('date');
  const forEmpID    = url.searchParams.get('forEmployeeID') || requesterID;

  if (!requesterID || !orgCode || !token || !dateISO) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // (0) валидируем вызывающего
  const who = await getEmployee(requesterID, [EMP_ORG_LOOKUP, EMP_TOKEN, EMP_STATUS, EMP_ROLE, EMP_FULLNAME]);
  if (!who) return json(res, 404, { error: 'employee not found' });

  const whoOrg = Array.isArray(who.fields?.[EMP_ORG_LOOKUP]) ? who.fields[EMP_ORG_LOOKUP][0] : who.fields?.[EMP_ORG_LOOKUP];
  if (!whoOrg) return json(res, 400, { error: 'employee org missing' });
  if (who.fields?.[EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  if (isCancelled(who.fields?.[EMP_STATUS])) return json(res, 403, { error: 'employee not active' });

  const isHR = String(who.fields?.[EMP_ROLE] || '').toUpperCase().includes('HR');

  // (1) Org recordId по коду
  const orgRecId = await getOrgRecIdByCode(orgCode);
  if (!orgRecId) return json(res, 400, { error: 'organization not found' });

  // Общая часть фильтра: активный заказ на дату и в этой Org
  const baseFilter = `AND(
    {${ORD_DATE_ISO}}='${dateISO}',
    NOT(OR(LOWER({${ORD_STATUS}})='cancelled',LOWER({${ORD_STATUS}})='canceled',LOWER({${ORD_STATUS}})='deleted')),
    {${ORD_ORG}}='${orgRecId}'
  )`;

  // ---------- LIST (HR) ----------
  if (mode === 'list') {
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    const r = await atGet(TBL_ORDERS, {
      filterByFormula: `AND(${baseFilter}, OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee'))`,
      "fields[]": [ORD_EMP, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK],
      pageSize: 100
    });
    const orders = r.records || [];
    if (!orders.length) return json(res, 200, { ok: true, items: [] });

    // Подтянем ФИО сотрудников
    const empIds = Array.from(new Set(orders.flatMap(o => o.fields?.[ORD_EMP] || [])));
    const empMap = new Map();
    if (empIds.length) {
      for (let i=0; i<empIds.length; i+=50) {
        const chunk = empIds.slice(i, i+50);
        const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const er = await atGet(TBL_EMPLOYEES, {
          filterByFormula: or,
          "fields[]": [EMP_FULLNAME, EMP_ORG_LOOKUP],
          pageSize: 50
        });
        (er.records || []).forEach(rec => {
          const f = rec.fields || {};
          const empOrg = Array.isArray(f[EMP_ORG_LOOKUP]) ? f[EMP_ORG_LOOKUP][0] : f[EMP_ORG_LOOKUP];
          if (empOrg === whoOrg || empOrg === orgCode) {
            empMap.set(rec.id, f[EMP_FULLNAME] || '');
          }
        });
      }
    }

    // Сборка карточек (короткая)
    const items = [];
    for (const o of orders) {
      const empId = Array.isArray(o.fields?.[ORD_EMP]) ? o.fields[ORD_EMP][0] : o.fields?.[ORD_EMP];
      if (!empId) continue;
      const fullName = empMap.get(empId) || '';

      let mealBox = composeBoxFromOrderFields(o.fields || {});
      if (!mealBox) mealBox = await composeBoxFromMealBoxes(o.fields?.[ORD_MB_LINK]);

      const [e1, e2] = await pickExtras(o.fields || {});

      items.push({
        employeeId: empId,
        fullName,
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

  // ---------- SINGLE (модалка сотрудника) ----------
  const targetEmpId = forEmpID;
  if (targetEmpId !== requesterID && !isHR) {
    return json(res, 403, { error: 'only HR can query for other employee' });
  }

  // ФИО для модалки
  let targetName = who.fields?.[EMP_FULLNAME] || '';
  if (targetEmpId !== requesterID) {
    const te = await getEmployee(targetEmpId, [EMP_FULLNAME, EMP_ORG_LOOKUP]);
    if (!te) return json(res, 404, { error: 'target employee not found' });
    const teOrg = Array.isArray(te.fields?.[EMP_ORG_LOOKUP]) ? te.fields[EMP_ORG_LOOKUP][0] : te.fields?.[EMP_ORG_LOOKUP];
    if (!(teOrg === whoOrg || teOrg === orgCode)) return json(res, 403, { error: 'target in another org' });
    targetName = te.fields?.[EMP_FULLNAME] || '';
  }

  const rr = await atGet(TBL_ORDERS, {
    filterByFormula: `AND(${baseFilter}, {${ORD_EMP}}='${targetEmpId}', OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee'))`,
    "fields[]": [ORD_STATUS, ORD_DATE, ORD_MAIN_TXT, ORD_SIDE_TXT, ORD_EXTRA_TXT, ORD_MB_LINK, ORD_OL_LINK],
    maxRecords: 1,
    pageSize: 1
  });
  const order = one(rr.records);
  if (!order) return json(res, 200, { ok: true, summary: null });

  let mealBox = composeBoxFromOrderFields(order.fields || {});
  if (!mealBox) mealBox = await composeBoxFromMealBoxes(order.fields?.[ORD_MB_LINK]);

  const [extra1, extra2] = await pickExtras(order.fields || {});

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
