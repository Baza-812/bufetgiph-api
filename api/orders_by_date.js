// api/orders_by_date.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../../lib/utils');

function mealBoxToText(mb, F) {
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
  const hrID         = url.searchParams.get('employeeID'); // HR id (requester)
  const org          = url.searchParams.get('org');
  const token        = url.searchParams.get('token');
  const date         = url.searchParams.get('date');
  const forEmployeeID= url.searchParams.get('forEmployeeID'); // optional: сузить до конкретного

  if (!hrID || !org || !token || !date) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // 1) Проверяем HR
  const whoResp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${hrID}'`,
    "fields[]": [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE],
    maxRecords: 1
  });
  const who = one(whoResp.records);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org) return json(res, 403, { error: 'org mismatch' });
  if (who.fields[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  const isHR = String(who.fields[F.EMP_ROLE] || '').toUpperCase().includes('HR');
  if (!isHR) return json(res, 403, { error: 'HR role required' });

  // 2) Находим активные Employee-заказы на дату в этой орг
  //   (не Cancelled/Deleted)
  const baseFilter = `
    AND(
      {${F.ORDER_TYPE}}='Employee',
      DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}',
      {${F.ORDER_ORG}}='${org}',
      AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))
    )`;

  let filter = baseFilter;
  if (forEmployeeID) {
    filter = `AND(${baseFilter}, FIND('${forEmployeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}&""))>0)`;
  }

  const ordersResp = await atGet(TABLE.ORDERS, {
    filterByFormula: filter,
    "fields[]": [F.ORDER_NO, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE],
    pageSize: 100
  });
  const orders = ordersResp.records || [];
  if (!orders.length) return json(res, 200, { ok: true, count: 0, items: [] });

  // 3) Подтянем ФИО сотрудников для сортировки
  const empIds = Array.from(new Set(orders.flatMap(o => o.fields?.[F.ORDER_EMPLOYEE] || [])));
  const empMap = new Map();
  if (empIds.length) {
    // ограничим OR(...) по 50 id на запрос если надо — но обычно мало
    const chunks = [];
    for (let i = 0; i < empIds.length; i += 50) chunks.push(empIds.slice(i, i+50));
    for (const ch of chunks) {
      const or = `OR(${ch.map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const e = await atGet(TABLE.EMPLOYEES, { filterByFormula: or, "fields[]":[F.EMP_NAME], pageSize: 50 });
      (e.records || []).forEach(r => empMap.set(r.id, r.fields?.[F.EMP_NAME] || ''));
    }
  }

  // 4) Для каждого заказа возьмём 1-й Meal Box и до двух Extra
  const items = [];
  for (const o of orders) {
    const orderId = o.id;

    const [mb, ol] = await Promise.all([
      atGet(TABLE.MEALBOXES,  { filterByFormula: `{${F.MB_ORDER}}='${orderId}'`, "fields[]":[F.MB_MAIN_NAME, F.MB_SIDE_NAME] }),
      atGet(TABLE.ORDERLINES, { filterByFormula: `{${F.OL_ORDER}}='${orderId}'`, "fields[]":[F.OL_NAME] })
    ]);

    const fullName = empMap.get((o.fields?.[F.ORDER_EMPLOYEE]||[])[0]) || '';
    const mealBox  = (mb.records && mb.records[0]) ? mealBoxToText(mb.records[0], F) : '';
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

  // 5) Сортируем по ФИО
  items.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ru'));

  return json(res, 200, { ok: true, count: items.length, items });
}, { windowMs: 4000, max: 15 });
