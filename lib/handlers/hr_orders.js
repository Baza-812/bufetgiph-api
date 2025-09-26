// /lib/handlers/hr_orders.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../../lib/utils');

// Собираем "Главное + Гарнир" как текст
function mealBoxToText(mb) {
  const f = mb?.fields || {};
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

  const requesterID = url.searchParams.get('employeeID');
  const org         = url.searchParams.get('org');
  const token       = url.searchParams.get('token');
  const date        = url.searchParams.get('date');
  const forEmpID    = url.searchParams.get('forEmployeeID');

  if (!requesterID || !org || !token || !date) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // проверяем вызывающего
  const who = await getEmployeeById(requesterID, [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE, F.EMP_NAME]);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org) return json(res, 403, { error: 'org mismatch' });
  if (who.fields[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });

  const isHR = String(who.fields[F.EMP_ROLE] || '').toUpperCase().includes('HR');

  // ================= list =================
  if (mode === 'list') {
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    // Активные employee-заказы на дату + ссылки на MB/OL
    const filter = onlyActiveOrderFormula(date, 'Employee', null);
    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: filter,
      "fields[]": [F.ORDER_EMPLOYEE, F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_MB_LINK, F.ORDER_OL_LINK],
      pageSize: 100
    });
    let orders = ordersResp.records || [];
    if (!orders.length) return json(res, 200, { ok: true, items: [] });

    // Соберем employee IDs
    const empIds = Array.from(new Set(
      orders.flatMap(o => o.fields?.[F.ORDER_EMPLOYEE] || [])
    ));

    // Подтянем ФИО и проверим Org
    const empMap = new Map(); // id -> name
    for (let i = 0; i < empIds.length; i += 50) {
      const chunk = empIds.slice(i, i + 50);
      const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const e = await atGet(TABLE.EMPLOYEES, {
        filterByFormula: or,
        "fields[]": [F.EMP_NAME, F.EMP_ORG_LOOKUP],
        pageSize: 50
      });
      (e.records || []).forEach(r => {
        const orgId = Array.isArray(r.fields[F.EMP_ORG_LOOKUP]) ? r.fields[F.EMP_ORG_LOOKUP][0] : r.fields[F.EMP_ORG_LOOKUP];
        if (orgId === org) empMap.set(r.id, r.fields[F.EMP_NAME] || '');
      });
    }

    // Соберем все ссылки на MB и OL
    const allMBIds = [];
    const allOLIds = [];
    for (const o of orders) {
      const mbIds = o.fields?.[F.ORDER_MB_LINK] || [];
      const olIds = o.fields?.[F.ORDER_OL_LINK] || [];
      allMBIds.push(...mbIds);
      allOLIds.push(...olIds);
    }

    // Батч: Meal Boxes
    const mbMap = new Map(); // id -> record
    if (allMBIds.length) {
      for (let i = 0; i < allMBIds.length; i += 50) {
        const chunk = allMBIds.slice(i, i + 50);
        const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const mb = await atGet(TABLE.MEALBOXES, {
          filterByFormula: or,
          "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME],
          pageSize: 50
        });
        (mb.records || []).forEach(r => mbMap.set(r.id, r));
      }
    }

    // Батч: Order Lines
    const olMap = new Map(); // id -> name
    if (allOLIds.length) {
      for (let i = 0; i < allOLIds.length; i += 50) {
        const chunk = allOLIds.slice(i, i + 50);
        const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const ol = await atGet(TABLE.ORDERLINES, {
          filterByFormula: or,
          "fields[]": [F.OL_NAME],
          pageSize: 50
        });
        (ol.records || []).forEach(r => {
          const nm = r.fields?.[F.OL_NAME];
          olMap.set(r.id, Array.isArray(nm) ? nm[0] : (nm || ''));
        });
      }
    }

    // Сборка элементов
    const items = [];
    for (const o of orders) {
      const employeeId = (o.fields?.[F.ORDER_EMPLOYEE] || [])[0];
      if (!employeeId) continue;

      // MB — берём первый по ссылке
      const mbIds = o.fields?.[F.ORDER_MB_LINK] || [];
      const mealBox = mbIds.length ? mealBoxToText(mbMap.get(mbIds[0])) : '';

      // Extras — первые две по ссылке
      const olIds = (o.fields?.[F.ORDER_OL_LINK] || []).slice(0, 2);
      const extraNames = olIds.map(id => olMap.get(id)).filter(Boolean);

      items.push({
        employeeId,
        fullName: empMap.get(employeeId) || '',
        date,
        orderId: o.id,
        mealBox,
        extra1: extraNames[0] || '',
        extra2: extraNames[1] || ''
      });
    }

    items.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ru'));
    return json(res, 200, { ok: true, items });
  }

  // ================= single =================
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
    "fields[]": [F.ORDER_NO, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE, F.ORDER_MB_LINK, F.ORDER_OL_LINK],
    maxRecords: 1
  });
  const order = one(orderResp.records);
  if (!order) return json(res, 200, { ok: true, summary: null, order: null });

  const mbIds = order.fields?.[F.ORDER_MB_LINK] || [];
  const olIds = (order.fields?.[F.ORDER_OL_LINK] || []).slice(0, 2);

  // подзагрузим детали
  const [mb, ol] = await Promise.all([
    mbIds.length
      ? atGet(TABLE.MEALBOXES,  { filterByFormula: `OR(${mbIds.map(id => `RECORD_ID()='${id}'`).join(',')})`, "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME] })
      : { records: [] },
    olIds.length
      ? atGet(TABLE.ORDERLINES, { filterByFormula: `OR(${olIds.map(id => `RECORD_ID()='${id}'`).join(',')})`, "fields[]": [F.OL_NAME] })
      : { records: [] }
  ]);

  const mealBox = mb.records?.length ? mealBoxToText(mb.records[0]) : '';
  const extras = (ol.records || []).map(r => {
    const nm = r.fields?.[F.OL_NAME];
    return Array.isArray(nm) ? nm[0] : (nm || '');
  }).filter(Boolean);

  const summary = {
    fullName: targetName,
    date,
    mealBox,
    extra1: extras[0] || '',
    extra2: extras[1] || '',
    orderId: order.id
  };

  return json(res, 200, {
    ok: true,
    summary,
    order,
    mealBoxes: mb.records || [],
    orderLines: ol.records || []
  });
}, { windowMs: 4000, max: 15 });
