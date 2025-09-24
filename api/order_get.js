// api/order_get.js
const { json, withRateLimit, atGet, one, TABLE, F, getLinkId } = require('./_utils');

function mealBoxToText(mb) {
  const f = mb.fields || {};
  const main = Array.isArray(f[F.MB_MAIN_NAME]) ? f[F.MB_MAIN_NAME][0] : f[F.MB_MAIN_NAME];
  const side = Array.isArray(f[F.MB_SIDE_NAME]) ? f[F.MB_SIDE_NAME][0] : f[F.MB_SIDE_NAME];
  if (main && side) return `${main} + ${side}`;
  if (main) return `${main}`;
  if (side) return `${side}`;
  return '';
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const employeeID    = url.searchParams.get('employeeID');   // requester
  const date          = url.searchParams.get('date');         // YYYY-MM-DD
  const org           = url.searchParams.get('org');
  const token         = url.searchParams.get('token');
  const forEmployeeID = url.searchParams.get('forEmployeeID'); // target (optional)

  if (!employeeID || !date || !org || !token) {
    return json(res, 400, { error: 'employeeID, date, org, token required' });
  }

  // 1) Проверяем вызывающего
  const whoResp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${employeeID}'`,
    "fields[]": [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS, F.EMP_ROLE, F.EMP_NAME],
    maxRecords: 1
  });
  const who = one(whoResp.records);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org) return json(res, 403, { error: 'org mismatch' });
  if (who.fields[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  const isHR = String(who.fields[F.EMP_ROLE] || '').toUpperCase().includes('HR');

  // 2) Определяем целевого сотрудника
  let targetEmpId = employeeID;
  if (forEmployeeID && forEmployeeID !== employeeID) {
    if (!isHR) return json(res, 403, { error: 'only HR can query on-behalf' });
    const te = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${forEmployeeID}'`,
      "fields[]": [F.EMP_ORG_LOOKUP, F.EMP_STATUS, F.EMP_NAME],
      maxRecords: 1
    });
    const teRec = one(te.records);
    if (!teRec) return json(res, 404, { error: 'target employee not found' });
    const teOrg = Array.isArray(teRec.fields[F.EMP_ORG_LOOKUP]) ? teRec.fields[F.EMP_ORG_LOOKUP][0] : teRec.fields[F.EMP_ORG_LOOKUP];
    if (teOrg !== org) return json(res, 403, { error: 'target in another org' });
    targetEmpId = teRec.id;
  }

  // 3) Ищем активный заказ на дату (не Cancelled/Deleted)
  const orderFilter = `
    AND(
      {${F.ORDER_TYPE}}='Employee',
      DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}',
      AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted')),
      FIND('${targetEmpId}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}&""))>0
    )`;
  const orderResp = await atGet(TABLE.ORDERS, {
    filterByFormula: orderFilter,
    "fields[]": [F.ORDER_NO, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE],
    maxRecords: 1
  });
  const order = one(orderResp.records);
  if (!order) {
    return json(res, 200, { ok: true, order: null, summary: null });
  }

  // 4) Дети (берём имена из Lookup-полей)
  const orderId = order.id;
  const mb = await atGet(TABLE.MEALBOXES, {
    filterByFormula: `{${F.MB_ORDER}}='${orderId}'`,
    "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME]
  });
  const ol = await atGet(TABLE.ORDERLINES, {
    filterByFormula: `{${F.OL_ORDER}}='${orderId}'`,
    "fields[]": [F.OL_NAME]
  });

  const fullName = forEmployeeID && forEmployeeID !== employeeID
    ? (one((await atGet(TABLE.EMPLOYEES, { filterByFormula:`RECORD_ID()='${forEmployeeID}'`, "fields[]":[F.EMP_NAME], maxRecords:1 })).records)?.fields?.[F.EMP_NAME] || '')
    : (who.fields[F.EMP_NAME] || '');

  const mealBox = mb.records && mb.records[0] ? mealBoxToText(mb.records[0]) : '';
  const extras = (ol.records || []).map(r => {
    const nm = r.fields?.[F.OL_NAME];
    return Array.isArray(nm) ? nm[0] : (nm || '');
  }).filter(Boolean).slice(0, 2);

  const summary = {
    fullName,
    date,
    mealBox,
    extra1: extras[0] || '',
    extra2: extras[1] || '',
    orderId
  };

  return json(res, 200, {
    ok: true,
    summary,
    // Можно оставить "raw" для отладки UI:
    order,
    mealBoxes: mb.records || [],
    orderLines: ol.records || []
  });
}, { windowMs: 4000, max: 20 });
