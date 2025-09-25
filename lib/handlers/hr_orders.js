// api/hr_orders.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../../lib/utils');

// Собираем "Главное + Гарнир" как текст
function mealBoxToText(mb) {
  const f = mb.fields || {};
  const main = Array.isArray(f[F.MB_MAIN_NAME]) ? f[F.MB_MAIN_NAME][0] : f[F.MB_MAIN_NAME];
  const side = Array.isArray(f[F.MB_SIDE_NAME]) ? f[F.MB_SIDE_NAME][0] : f[F.MB_SIDE_NAME];
  if (main && side) return `${main} + ${side}`;
  if (main) return `${main}`;
  if (side) return `${side}`;
  return '';
}

async function getEmployeeById(id, extraFields = []) {
  const resp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${id}'`,
    "fields[]": extraFields,
    maxRecords: 1
  });
  return one(resp.records);
}

function onlyActiveOrderFormula(date, typeFilter, employeeIdFilter) {
  const parts = [
    `DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}'`,
    `AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))`
  ];
  if (typeFilter) parts.push(`{${F.ORDER_TYPE}}='${typeFilter}'`);
  if (employeeIdFilter) {
    parts.push(`FIND('${employeeIdFilter}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}&""))>0`);
  }
  return `AND(${parts.join(',')})`;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = (url.searchParams.get('mode') || 'list').toLowerCase();

  const requesterID = url.searchParams.get('employeeID'); // HR или сам сотрудник
  const org         = url.searchParams.get('org');
  const token       = url.searchParams.get('token');
  const date        = url.searchParams.get('date');       // YYYY-MM-DD
  const forEmpID    = url.searchParams.get('forEmployeeID'); // таргет-сотрудник (опц.)

  if (!requesterID || !org || !token || !date) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // 1) Проверяем вызывающего
  const who = await getEmployeeById(requesterID, [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE, F.EMP_NAME]);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org)                return json(res, 403, { error: 'org mismatch' });
  if (who.fields[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });

  const isHR = String(who.fields[F.EMP_ROLE] || '').toUpperCase().includes('HR');

  // === РЕЖИМ A: список для HR ===
  if (mode === 'list') {
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    // Активные employee-заказы на дату в этой орг
    const filter = onlyActiveOrderFormula(date, 'Employee', null);
    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: filter,
      "fields[]": [F.ORDER_NO, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE],
      pageSize: 100
    });
    const orders = ordersResp.records || [];
    if (!orders.length) return json(res, 200, { ok: true, count: 0, items: [] });

    // Подтягиваем ФИО для сортировки
    const empIds = Array.from(new Set(orders.flatMap(o => o.fields?.[F.ORDER_EMPLOYEE] || [])));
    const empMap = new Map();
    if (empIds.length) {
      const chunks = [];
      for (let i = 0; i < empIds.length; i += 50) chunks.push(empIds.slice(i, i + 50));
      for (const ch of chunks) {
        const or = `OR(${ch.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const e = await atGet(TABLE.EMPLOYEES, { filterByFormula: or, "fields[]": [F.EMP_NAME], pageSize: 50 });
        (e.records || []).forEach(r => empMap.set(r.id, r.fields?.[F.EMP_NAME] || ''));
      }
    }

    // Для каждого заказа забираем 1-й Meal Box и до двух Extras
    const items = [];
    for (const o of orders) {
      const orderId = o.id;
      const [mb, ol] = await Promise.all([
        atGet(TABLE.MEALBOXES,  { filterByFormula: `{${F.MB_ORDER}}='${orderId}'`, "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME] }),
        atGet(TABLE.ORDERLINES, { filterByFormula: `{${F.OL_ORDER}}='${orderId}'`, "fields[]": [F.OL_NAME] })
      ]);

      const fullName = empMap.get((o.fields?.[F.ORDER_EMPLOYEE] || [])[0]) || '';
      const mealBox  = (mb.records && mb.records[0]) ? mealBoxToText(mb.records[0]) : '';
      const extras   = (ol.records || []).map(r => {
        const nm = r.fields?.[F.OL_NAME];
        return Array.isArray(nm) ? nm[0] : (nm || '');
      }).filter(Boolean).slice(0, 2);

      items.push({
        fullName,
        date,
        mealBox,
        extra1: extras[0] || '',
        extra2: extras[1] || '',
        orderId
      });
    }

    // Сортируем по ФИО
    items.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ru'));
    return json(res, 200, { ok: true, count: items.length, items });
  }

  // === РЕЖИМ B: single (HR о сотруднике ИЛИ сам сотрудник о себе)
  let targetEmpId = requesterID;
  let targetName  = who.fields[F.EMP_NAME] || '';
  if (forEmpID && forEmpID !== requesterID) {
    if (!isHR) return json(res, 403, { error: 'only HR can query on-behalf' });
    const te = await getEmployeeById(forEmpID, [F.EMP_ORG_LOOKUP, F.EMP_NAME]);
    if (!te) return json(res, 404, { error: 'target employee not found' });
    const teOrg = Array.isArray(te.fields[F.EMP_ORG_LOOKUP]) ? te.fields[F.EMP_ORG_LOOKUP][0] : te.fields[F.EMP_ORG_LOOKUP];
    if (teOrg !== org) return json(res, 403, { error: 'target in another org' });
    targetEmpId = te.id;
    targetName  = te.fields[F.EMP_NAME] || '';
  }

  const singleFilter = onlyActiveOrderFormula(date, 'Employee', targetEmpId);
  const orderResp = await atGet(TABLE.ORDERS, {
    filterByFormula: singleFilter,
    "fields[]": [F.ORDER_NO, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE],
    maxRecords: 1
  });
  const order = one(orderResp.records);
  if (!order) return json(res, 200, { ok: true, summary: null, order: null });

  const orderId = order.id;
  const [mb, ol] = await Promise.all([
    atGet(TABLE.MEALBOXES,  { filterByFormula: `{${F.MB_ORDER}}='${orderId}'`, "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME] }),
    atGet(TABLE.ORDERLINES, { filterByFormula: `{${F.OL_ORDER}}='${orderId}'`, "fields[]": [F.OL_NAME] })
  ]);

  const mealBox = (mb.records && mb.records[0]) ? mealBoxToText(mb.records[0]) : '';
  const extras = (ol.records || []).map(r => {
    const nm = r.fields?.[F.OL_NAME];
    return Array.isArray(nm) ? nm[0] : (nm || '');
  }).filter(Boolean).slice(0, 2);

  const summary = {
    fullName: targetName,
    date,
    mealBox,
    extra1: extras[0] || '',
    extra2: extras[1] || '',
    orderId
  };

  return json(res, 200, {
    ok: true,
    summary,
    order,
    mealBoxes: mb.records || [],
    orderLines: ol.records || []
  });
}, { windowMs: 4000, max: 15 });
