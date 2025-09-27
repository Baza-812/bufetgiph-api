// /lib/handlers/busy.js
const { json, withRateLimit, atGet, TABLE, F } = require('../../lib/utils');

// Ровно та же функция, что в hr_orders.js
function onlyActiveOrderFormula(date, typeFilter, employeeId) {
  const parts = [
    `DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}'`,
    `AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))`,
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
  const org        = url.searchParams.get('org') || '';
  const token      = url.searchParams.get('token') || '';
  const datesParam = (url.searchParams.get('dates') || '').trim();
  const debug      = url.searchParams.get('debug') === '1';

  if (!employeeID || !org || !token || !datesParam) {
    return json(res, 400, { error: 'employeeID, org, token, dates required' });
  }

  const dates = datesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!dates.length) return json(res, 400, { error: 'no dates' });

  const busy = {};
  const dbg  = [];

  // Делаем «как в single»: по одной дате — один запрос
  for (const d of dates) {
    const filter = onlyActiveOrderFormula(d, 'Employee', employeeID);
    const r = await atGet(TABLE.ORDERS, {
      filterByFormula: filter,
      "fields[]": [F.ORDER_DATE, F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_TYPE],
      maxRecords: 1,
    });
    const has = (r.records || []).length > 0;
    busy[d] = has;

    if (debug) {
      dbg.push({
        date: d,
        filter,
        found: has ? r.records.map(x => x.id) : [],
      });
    }
  }

  return json(res, 200, debug ? { ok: true, busy, debug: dbg } : { ok: true, busy });
}, { windowMs: 4000, max: 20 });
