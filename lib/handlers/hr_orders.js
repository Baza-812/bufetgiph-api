// /lib/handlers/hr_orders.js
// HR/orders: mode=list (сводка на дату) и mode=single (карточка одного сотрудника для модалки).
// Под реальную схему Airtable из "Структура Airtable.txt".

const { json, withRateLimit, atGet, one, TABLE, F } = require('../utils');

// === Таблицы
const TBL_ORDERS     = TABLE.ORDERS     || 'Orders';
const TBL_EMPLOYEES  = TABLE.EMPLOYEES  || 'Employees';
const TBL_ORGS       = TABLE.ORGS       || 'Organizations';
const TBL_MB         = TABLE.MEALBOXES  || 'Meal Boxes';
const TBL_OL         = TABLE.ORDERLINES || 'Order Lines';

// === Поля Employees
const EMP_FULLNAME   = 'Employee Full Name' /* у тебя это агрегат/лукап в Orders; в Employees для валидации не нужно */;
const EMP_ORG_LOOKUP = 'OrgID (from Organization)';
const EMP_TOKEN      = 'Order Token';
const EMP_STATUS     = 'Status';
const EMP_ROLE       = 'Role';

// === Поля Orders
const FLD_ORDER_NO       = 'Order No';
const FLD_ORDER_DATE     = 'Order Date';
const FLD_ORDER_DATE_ISO = 'OrderDateISO';
const FLD_ORDER_TYPE     = 'Order Type';       // 'Employee' / 'Manager'
const FLD_ORDER_EMP      = 'Employee';         // link -> Employees
const FLD_ORDER_ORG      = 'Org';              // link -> Organizations
const FLD_ORDER_STATUS   = 'Status';
const FLD_ORDER_MB       = 'Meal Boxes';       // link -> Meal Boxes
const FLD_ORDER_OL       = 'Order Lines';      // link -> Order Lines

// === Готовые поля для модалки (лежат в Orders)
const FLD_EMP_FULLNAME   = 'Employee Full Name';
const FLD_MB_SUMMARY     = 'Meal Box Summary';
const FLD_EXTRA1_NAME    = 'Extra 1 Name';
const FLD_EXTRA2_NAME    = 'Extra 2 Name';

// === Поля Orgs
const FLD_ORG_CODE       = F.ORG_ID || 'OrgID';

// === Утилиты
const lower = (s) => String(s || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled' || s === 'deleted';
};

function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

async function getEmployee(empId) {
  const r = await atGet(TBL_EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${empId}'`,
    "fields[]": [EMP_ORG_LOOKUP, EMP_TOKEN, EMP_STATUS, EMP_ROLE],
    maxRecords: 1, pageSize: 1
  });
  return one(r.records);
}

async function getOrgRecIdByCode(orgCode) {
  const r = await atGet(TBL_ORGS, {
    filterByFormula: eqStr(FLD_ORG_CODE, orgCode),
    "fields[]": [], maxRecords: 1, pageSize: 1
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

// === handler
module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = (url.searchParams.get('mode') || 'list').toLowerCase();

  const requesterID = url.searchParams.get('employeeID'); // тот, кто вызывает (сотрудник/HR)
  const orgCode     = url.searchParams.get('org');        // OrgID
  const token       = url.searchParams.get('token');
  const dateISO     = url.searchParams.get('date');       // YYYY-MM-DD

  if (!requesterID || !orgCode || !token || !dateISO) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // 0) Валидация вызывающего
  const who = await getEmployee(requesterID);
  if (!who) return json(res, 404, { error: 'employee not found' });

  const whoOrg = Array.isArray(who.fields?.[EMP_ORG_LOOKUP]) ? who.fields[EMP_ORG_LOOKUP][0] : who.fields?.[EMP_ORG_LOOKUP];
  if (!whoOrg) return json(res, 400, { error: 'employee org missing' });
  if (who.fields?.[EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  if (isCancelled(who.fields?.[EMP_STATUS])) return json(res, 403, { error: 'employee not active' });

  const isHR = String(who.fields?.[EMP_ROLE] || '').toUpperCase().includes('HR');

  // 1) Запись Organizations по коду org
  const orgRecId = await getOrgRecIdByCode(orgCode);
  if (!orgRecId) return json(res, 400, { error: 'organization not found' });

  // Общая часть фильтра: активный employee-заказ на дату и в этой организации
  const baseFilter = `AND(
    {${FLD_ORDER_DATE_ISO}}='${dateISO}',
    OR(LEN({${FLD_ORDER_TYPE}})=0, LOWER({${FLD_ORDER_TYPE}})='employee'),
    NOT(OR(LOWER({${FLD_ORDER_STATUS}})='cancelled',LOWER({${FLD_ORDER_STATUS}})='canceled',LOWER({${FLD_ORDER_STATUS}})='deleted')),
    {${FLD_ORDER_ORG}}='${orgRecId}'
  )`;

  if (mode === 'list') {
    // HR-таблица за день
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    const r = await atGet(TBL_ORDERS, {
      filterByFormula: baseFilter,
      "fields[]": [FLD_ORDER_EMP, FLD_ORDER_STATUS, FLD_ORDER_MB, FLD_ORDER_OL],
      pageSize: 100
    });
    const recs = r.records || [];
    if (!recs.length) return json(res, 200, { ok: true, items: [] });

    // Подтягиваем ФИО из Orders лукапов (чтобы не делать второй проход по Employees)
    // и формируем «короткий» состав (Meal Box Summary / Extra 1/2 Name есть прямо в Orders —
    // но на некоторых записях их может не быть; тогда вернём пустые строки).
    // Для экономии запросов здесь не тянем MB/OL; для модалки у нас будет mode=single.
    const items = recs.map(o => ({
      employeeId: Array.isArray(o.fields?.[FLD_ORDER_EMP]) ? o.fields[FLD_ORDER_EMP][0] : o.fields?.[FLD_ORDER_EMP],
      fullName:   o.fields?.[FLD_EMP_FULLNAME] || '',
      date:       dateISO,
      orderId:    o.id,
      mealBox:    o.fields?.[FLD_MB_SUMMARY]  || '',
      extra1:     o.fields?.[FLD_EXTRA1_NAME] || '',
      extra2:     o.fields?.[FLD_EXTRA2_NAME] || '',
    })).filter(x => !!x.employeeId);

    items.sort((a,b)=> (a.fullName||'').localeCompare(b.fullName||'','ru'));
    return json(res, 200, { ok: true, items });
  }

  // mode=single — карточка одного сотрудника (для модалки). По умолчанию — сам сотрудник.
  const forEmpID = url.searchParams.get('forEmployeeID') || requesterID;
  if (forEmpID !== requesterID && !isHR) {
    return json(res, 403, { error: 'only HR can query for other employee' });
  }

  const r = await atGet(TBL_ORDERS, {
    filterByFormula: `AND(${baseFilter}, {${FLD_ORDER_EMP}}='${forEmpID}')`,
    "fields[]": [
      FLD_ORDER_STATUS, FLD_ORDER_DATE, FLD_ORDER_MB, FLD_ORDER_OL,
      FLD_EMP_FULLNAME, FLD_MB_SUMMARY, FLD_EXTRA1_NAME, FLD_EXTRA2_NAME
    ],
    maxRecords: 1, pageSize: 1
  });
  const rec = one(r.records);
  if (!rec) return json(res, 200, { ok: true, summary: null });

  const summary = {
    fullName: rec.fields?.[FLD_EMP_FULLNAME] || '',
    date:     dateISO,
    mealBox:  rec.fields?.[FLD_MB_SUMMARY]   || '',
    extra1:   rec.fields?.[FLD_EXTRA1_NAME]  || '',
    extra2:   rec.fields?.[FLD_EXTRA2_NAME]  || '',
    orderId:  rec.id
  };

  return json(res, 200, { ok: true, summary });
}, { windowMs: 4000, max: 15 });
