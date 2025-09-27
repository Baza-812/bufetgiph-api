// /api/busy.js
const { json, withRateLimit, atGet, TABLE, F } = require('../lib/utils');

// ——— формула поиска заказов конкретного сотрудника
function employeeFormula(employeeID) {
  // Поиск по линк-полю "Employee" (массив recID): SEARCH('rec...', ARRAYJOIN({Employee})) > 0
  const byLink = `SEARCH('${employeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}})) > 0`;

  // Фолбэк: если задано текстовое/lookup поле с recID сотрудника в таблице Orders (например, "EmployeeID")
  // переменная берётся из .env как FLD_ORDER_EMPLOYEEID
  const fld = (F.ORDER_EMPLOYEEID || '').trim?.() || '';
  if (fld) {
    const byText = `{${fld}}='${employeeID}'`;
    return `OR(${byLink}, ${byText})`;
  }
  return byLink;
}

// ——— дата: сравнение «день в день»
function isSameDayFormula(field, isoDate) {
  // В Airtable дата хранится в timezone базы. Сравниваем по дню:
  // IS_SAME({Order Date}, DATETIME_PARSE('2025-10-01'), 'day')
  return `IS_SAME({${field}}, DATETIME_PARSE('${isoDate}'), 'day')`;
}

// ——— статус активного заказа
function activeStatusFormula() {
  // Подгони список статусов под свою схему при необходимости:
  // New / Active / Approved считаем «занятым» днём
  return `OR({${F.ORDER_STATUS}}='New',{${F.ORDER_STATUS}}='Active',{${F.ORDER_STATUS}}='Approved')`;
}

// ——— тип заказа: только «Employee»
function employeeTypeFormula() {
  return `{${F.ORDER_TYPE}}='Employee'`;
}

// ——— фильтр по организации (по коду OrgID в заказе)
function orgFormula(org) {
  return `{${F.ORDER_ORG_ID}}='${org}'`;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const { employeeID, org, token, dates = '', debug: wantDebug } = req.query || {};
  // token сейчас не проверяем тут; авторизация может быть на другом уровне

  if (!employeeID || !org) {
    return json(res, 400, { error: 'employeeID and org are required' });
  }

  const list = String(dates || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (list.length === 0) {
    return json(res, 200, { ok: true, busy: {} });
  }

  const busy = {};
  const debug = [];

  // Бежим по датам и проверяем наличие активного заказа
  for (const d of list) {
    const f = [
      employeeFormula(employeeID),
      orgFormula(org),
      isSameDayFormula(F.ORDER_DATE, d),
      employeeTypeFormula(),
      activeStatusFormula(),
    ].join(',');

    const filterByFormula = `AND(${f})`;

    // Берём максимум 1 запись — нам важен факт наличия
    const resp = await atGet(TABLE.ORDERS, {
      maxRecords: 1,
      filterByFormula,
      // Поля для отладки/экономии трафика можно ограничить:
      "fields[]": [F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_TYPE, F.ORDER_ORG_ID],
    });

    const has = Array.isArray(resp?.records) && resp.records.length > 0;
    busy[d] = !!has;

    if (wantDebug) {
      debug.push({ date: d, filterByFormula, found: has ? resp.records[0]?.id : null });
    }
  }

  return json(res, 200, { ok: true, busy, ...(wantDebug ? { debug } : {}) });
});
