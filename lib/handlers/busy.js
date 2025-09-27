// /lib/handlers/busy.js
const { json, withRateLimit, atGet, TABLE, F } = require('../../lib/utils');

function onlyActiveOrderFormula(date, typeFilter, employeeId) {
  const parts = [
    `DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}'`,
    `AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))`
  ];
  if (typeFilter) parts.push(`{${F.ORDER_TYPE}}='${typeFilter}'`);
  if (employeeId) parts.push(`FIND('${employeeId}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}&""))>0`);
  return `AND(${parts.join(',')})`;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url        = new URL(req.url, `http://${req.headers.host}`);
  const employeeID = url.searchParams.get('employeeID') || '';
  const org        = url.searchParams.get('org') || '';     // сейчас не используем в фильтре — всё равно привязка идёт по employeeID
  const token      = url.searchParams.get('token') || '';   // сюда можно добавить валидацию, если потребуется
  const datesParam = (url.searchParams.get('dates') || '').trim();

  if (!employeeID || !org || !token || !datesParam) {
    return json(res, 400, { error: 'employeeID, org, token, dates required' });
  }

  // список дат
  const dates = datesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!dates.length) return json(res, 400, { error: 'no dates' });

  // Соберём формулу: OR(formula(date1), formula(date2), ...)
  // + общие условия (Order Type/EmployeeID/Status) зашьём ВНУТРЬ каждого AND(...)
  // чтобы быть предельно совместимыми с логикой /api/hr_orders
  const perDateFormulas = dates.map(d => onlyActiveOrderFormula(d, 'Employee', employeeID));
  const filterByFormula = perDateFormulas.length === 1
    ? perDateFormulas[0]
    : `OR(${perDateFormulas.join(',')})`;

  // Запрашиваем заказы только нужных полей (экономим квоту)
  const r = await atGet(TABLE.ORDERS, {
    filterByFormula,
    pageSize: 100,
    "fields[]": [F.ORDER_DATE, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_TYPE]
  });

  // Построим множество занятых дат по ответу Airtable
  const busySet = new Set();
  for (const rec of (r.records || [])) {
    const f = rec.fields || {};
    const iso = (() => {
      // выровняем к 'YYYY-MM-DD'
      const v = f[F.ORDER_DATE];
      if (!v) return '';
      try {
        // если поле — дата/время, всё равно форматируем через JS к YYYY-MM-DD
        const d = new Date(v);
        if (!isFinite(d)) return '';
        const y = d.getFullYear();
        const m = String(d.getMonth()+1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      } catch { return ''; }
    })();
    if (iso) busySet.add(iso);
  }

  // Ответ — ровно по входным датам
  const busy = {};
  for (const d of dates) busy[d] = busySet.has(d);

  return json(res, 200, { ok: true, busy });
}, { windowMs: 4000, max: 20 });
