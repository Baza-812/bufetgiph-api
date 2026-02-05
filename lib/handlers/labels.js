// /lib/handlers/labels.js
// API для генерации маркировки в формате XLSX
// Каждое блюдо (Meal Box, Extra1, Extra2) в отдельной строке

const { json, atGet, TABLE, F } = require('../utils');

const lower = (v) => String(v || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled';
};

const ORDERS      = TABLE.ORDERS     || 'Orders';
const MEALBOXES   = TABLE.MEALBOXES  || 'Meal Boxes';
const ORDERLINES  = TABLE.ORDERLINES || 'Order Lines';
const ORGS        = TABLE.ORGS       || 'Organizations';
const EMPLOYEES   = TABLE.EMPLOYEES  || 'Employees';

const FLD_STATUS        = F.ORDER_STATUS   || 'Status';
const FLD_ORDER_ORG     = 'Org';
const DATE_FIELDS_TRY   = ['OrderDateISO', 'Order Date ISO'];

const FLD_ORDER_MB_LINK = F.ORDER_MB_LINK  || 'Meal Boxes';
const FLD_ORDER_OL_LINK = F.ORDER_OL_LINK  || 'Order Lines';
const FLD_ORDER_EMPLOYEE = F.ORDER_EMPLOYEE || 'Employee';

// Поля в Meal Boxes
const FLD_MB_QTY        = F.MB_QTY         || 'Quantity';
const FLD_MB_MAIN_NAME  = F.MB_MAIN_NAME   || 'Main Name';
const FLD_MB_SIDE_NAME  = F.MB_SIDE_NAME   || 'Side Name';
const FLD_MB_MAIN_DESC  = 'Main Description'; // Описание основного
const FLD_MB_SIDE_DESC  = 'Side Description'; // Описание гарнира

// Поля в Order Lines
const FLD_OL_QTY        = F.OL_QTY         || 'Quantity';
const FLD_OL_ITEM_NAME  = F.OL_ITEM_NAME   || 'Item Name';
const FLD_OL_ITEM_DESC  = 'Item Description'; // Описание блюда

// Поля в Employees
const FLD_EMP_NAME      = F.EMP_NAME       || 'Full Name';

function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

async function getOrgRecordIdAndName(orgCode) {
  const r = await atGet(ORGS, {
    maxRecords: 1,
    filterByFormula: eqStr(F.ORG_ID || 'OrgID', orgCode),
    "fields[]": [F.ORG_NAME || 'Name'],
  });
  const rec = (r.records || [])[0];
  if (!rec) return null;
  return { 
    id: rec.id, 
    name: String(rec.fields?.[F.ORG_NAME || 'Name'] || orgCode).trim() 
  };
}

async function fetchOrdersByDateField(dateField, isoDate) {
  const r = await atGet(ORDERS, {
    filterByFormula: eqStr(dateField, isoDate),
    pageSize: 100,
  });
  return r.records || [];
}

async function fetchByIdsChunked(table, ids, fields = []) {
  if (!ids || !ids.length) return [];
  const out = [];
  const chunk = 40;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const or = `OR(${part.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const opts = { filterByFormula: or, pageSize: 100 };
    if (fields.length) opts["fields[]"] = fields;
    const r = await atGet(table, opts);
    out.push(...(r.records || []));
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, date } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // 1) Получаем организацию
    const orgData = await getOrgRecordIdAndName(org);
    if (!orgData) return json(res, 404, { error: 'Organization not found' });

    // 2) Находим заказы на эту дату
    let usedDateField = null;
    let onDate = [];
    for (const df of DATE_FIELDS_TRY) {
      const recs = await fetchOrdersByDateField(df, date);
      if (recs.length) { 
        usedDateField = df; 
        onDate = recs; 
        break; 
      }
    }

    if (!usedDateField || !onDate.length) {
      return json(res, 200, { 
        ok: true, 
        orgName: orgData.name,
        dateLabel: date,
        rows: [] 
      });
    }

    // 3) Активные заказы этой организации
    const belongsToOrg = (rec) => {
      const link = (rec.fields || {})[FLD_ORDER_ORG];
      if (Array.isArray(link)) return link.includes(orgData.id);
      return link === orgData.id;
    };

    const active = onDate.filter(o => !isCancelled(o.fields?.[FLD_STATUS]));
    const ofOrg = active.filter(belongsToOrg);

    if (!ofOrg.length) {
      return json(res, 200, { 
        ok: true, 
        orgName: orgData.name,
        dateLabel: date,
        rows: [] 
      });
    }

    // 4) Собираем все линки на Meal Boxes и Order Lines
    const allMbIds = [];
    const allOlIds = [];
    const orderToEmployee = new Map(); // orderId -> employeeId

    for (const ord of ofOrg) {
      const f = ord.fields || {};
      const mbIds = Array.isArray(f[FLD_ORDER_MB_LINK]) ? f[FLD_ORDER_MB_LINK] : [];
      const olIds = Array.isArray(f[FLD_ORDER_OL_LINK]) ? f[FLD_ORDER_OL_LINK] : [];
      
      allMbIds.push(...mbIds);
      allOlIds.push(...olIds);

      // Сохраняем связь order -> employee
      const empLink = f[FLD_ORDER_EMPLOYEE];
      const empId = Array.isArray(empLink) ? empLink[0] : empLink;
      if (empId) orderToEmployee.set(ord.id, empId);
    }

    // 5) Получаем все записи Meal Boxes и Order Lines
    const [mbRecs, olRecs] = await Promise.all([
      fetchByIdsChunked(MEALBOXES, allMbIds, [
        FLD_MB_QTY, 
        FLD_MB_MAIN_NAME, 
        FLD_MB_SIDE_NAME,
        FLD_MB_MAIN_DESC,
        FLD_MB_SIDE_DESC,
        'Order' // линк обратно на Order
      ]),
      fetchByIdsChunked(ORDERLINES, allOlIds, [
        FLD_OL_QTY, 
        FLD_OL_ITEM_NAME,
        FLD_OL_ITEM_DESC,
        'Order' // линк обратно на Order
      ]),
    ]);

    // 6) Получаем всех сотрудников
    const allEmpIds = Array.from(new Set(orderToEmployee.values()));
    const empRecs = await fetchByIdsChunked(EMPLOYEES, allEmpIds, [FLD_EMP_NAME]);
    const empIdToName = new Map();
    for (const emp of empRecs) {
      empIdToName.set(emp.id, String(emp.fields?.[FLD_EMP_NAME] || '').trim());
    }

    // 7) Формируем массив строк для маркировки
    const rows = [];

    // Обрабатываем Meal Boxes
    for (const mb of mbRecs) {
      const mf = mb.fields || {};
      const qty = Math.max(0, Number(mf[FLD_MB_QTY] || 0)) || 0;
      if (!qty) continue;

      const main = (mf[FLD_MB_MAIN_NAME] || '').toString().trim();
      const side = (mf[FLD_MB_SIDE_NAME] || '').toString().trim();
      const mainDesc = (mf[FLD_MB_MAIN_DESC] || '').toString().trim();
      const sideDesc = (mf[FLD_MB_SIDE_DESC] || '').toString().trim();

      // Комбинируем название и описание для Meal Box
      const dishName = side ? `${main} + ${side}` : (main || 'Meal Box');
      const dishDescription = [mainDesc, sideDesc].filter(Boolean).join(' | ');

      // Определяем сотрудника
      const orderLink = mf['Order'];
      const orderId = Array.isArray(orderLink) ? orderLink[0] : orderLink;
      const empId = orderToEmployee.get(orderId);
      const fullName = empId ? (empIdToName.get(empId) || '') : '';

      // Добавляем qty строк (каждая порция - отдельная строка)
      for (let i = 0; i < qty; i++) {
        rows.push({
          fullName,
          orderDate: date,
          dishName,
          dishDescription,
        });
      }
    }

    // Обрабатываем Order Lines (Extra1, Extra2)
    for (const ol of olRecs) {
      const of = ol.fields || {};
      const qty = Math.max(0, Number(of[FLD_OL_QTY] || 0)) || 0;
      const name = (of[FLD_OL_ITEM_NAME] || '').toString().trim();
      const desc = (of[FLD_OL_ITEM_DESC] || '').toString().trim();
      
      if (!name || !qty) continue;

      // Определяем сотрудника
      const orderLink = of['Order'];
      const orderId = Array.isArray(orderLink) ? orderLink[0] : orderLink;
      const empId = orderToEmployee.get(orderId);
      const fullName = empId ? (empIdToName.get(empId) || '') : '';

      // Добавляем qty строк
      for (let i = 0; i < qty; i++) {
        rows.push({
          fullName,
          orderDate: date,
          dishName: name,
          dishDescription: desc,
        });
      }
    }

    // 8) Возвращаем данные
    return json(res, 200, { 
      ok: true,
      orgName: orgData.name,
      dateLabel: date,
      rows 
    });

  } catch (e) {
    console.error('[labels] Error:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
