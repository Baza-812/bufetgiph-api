// /lib/handlers/busy.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../../lib/utils');

// берём проверку вызывающего как в hr_orders.js
async function getEmployeeById(id, extraFields = []) {
  const resp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${id}'`,
    "fields[]": extraFields,
    maxRecords: 1
  });
  return one(resp.records);
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);

  const employeeID = url.searchParams.get('employeeID'); // вызывающий (сам сотрудник)
  const org        = url.searchParams.get('org');
  const token      = url.searchParams.get('token');
  const datesCsv   = url.searchParams.get('dates') || ''; // 'YYYY-MM-DD,YYYY-MM-DD,...'
  const typeFilter = url.searchParams.get('type') || 'Employee'; // по умолчанию ваши заказы

  if (!employeeID || !org || !token || !datesCsv) {
    return json(res, 400, { error: 'employeeID, org, token, dates required' });
  }

  // 1) валидируем вызывающего
  const who = await getEmployeeById(employeeID, [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE, F.EMP_NAME]);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org)                return json(res, 403, { error: 'org mismatch' });
  if (who.fields[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });

  // 2) готовим OR по датам
  const dates = datesCsv.split(',').map(s => s.trim()).filter(Boolean);
  if (!dates.length) return json(res, 400, { error: 'no dates' });

  // пример: OR(DATETIME_FORMAT({Order Date}, 'YYYY-MM-DD')='2025-10-04', ...)
  const orDates = `OR(${dates.map(d => `DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${d}'`).join(',')})`;

  // 3) фильтр:
  //   - только «живые» заказы: НЕ Cancelled/Deleted
  //   - только нужный тип (Employee)
  //   - только по сотруднику (через link; для надёжности используем и Lookup, если есть)
  //   - только указанные даты
  const parts = [
    orDates,
    `AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))`,
  ];
  if (typeFilter) parts.push(`{${F.ORDER_TYPE}}='${typeFilter}'`);

  // Привязка к сотруднику: через link-поле (как в hr_orders.js)
  parts.push(`FIND('${employeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}&""))>0`);

  const filter = `AND(${parts.join(',')})`;

  // 4) читаем минимальный набор полей
  const resp = await atGet(TABLE.ORDERS, {
    filterByFormula: filter,
    "fields[]": [F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_EMPLOYEE],
    pageSize: 100
  });

  // 5) собираем карту занятости
  const busy = {};
  for (const r of (resp.records || [])) {
    const dt = r.fields?.[F.ORDER_DATE];
    if (!dt) continue;
    const d = new Date(dt);
    const iso = isNaN(d.getTime())
      ? String(dt) // если уже строка YYYY-MM-DD
      : d.toISOString().slice(0,10);
    busy[iso] = true;
  }

  // вернём только даты из запроса (true/false)
  const out = {};
  for (const d of dates) out[d] = Boolean(busy[d]);

  return json(res, 200, { ok: true, busy: out });
}, { windowMs: 3000, max: 20 });
