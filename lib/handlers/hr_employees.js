// /lib/handlers/hr_employees.js
const { json, withRateLimit, atGet, listAll, TABLE, F } = require('../../lib/utils');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org   = url.searchParams.get('org');
  const empId = url.searchParams.get('employeeID');
  const token = url.searchParams.get('token');

  if (!org || !empId || !token) {
    return json(res, 400, { error: 'org, employeeID, token required' });
  }

  // Проверяем вызывающего (org + token)
  const meResp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${empId}'`,
    "fields[]": [F.EMP_ORG_LOOKUP, F.EMP_TOKEN],
    maxRecords: 1
  });
  const me = (meResp.records || [])[0];
  if (!me) return json(res, 404, { error: 'employee not found' });

  const meOrg = Array.isArray(me.fields[F.EMP_ORG_LOOKUP])
    ? me.fields[F.EMP_ORG_LOOKUP][0]
    : me.fields[F.EMP_ORG_LOOKUP];

  if (meOrg !== org)                 return json(res, 403, { error: 'org mismatch' });
  if (me.fields[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });

  // Берём сотрудников этой организации
  const filter = `{${F.EMP_ORG_LOOKUP}}='${org}'`;

  // ВНИМАНИЕ: указываем только существующие поля!
  const fields = [
    F.EMP_NAME,     // "FullName" — как в вашей базе
    'Email',        // если у вас другое имя, скажите — поменяем
    F.EMP_STATUS,   // "Status"
    F.EMP_ROLE,     // "Role"
    F.EMP_TOKEN     // "Order Token" (наличие персонального токена)
  ];

  const records = await listAll(TABLE.EMPLOYEES, {
    filterByFormula: filter,
    "fields[]": fields,
    pageSize: 100
  });

  const items = (records || []).map(r => {
    const f = r.fields || {};
    return {
      id: r.id,
      name: f[F.EMP_NAME] || '',  // берём строго FullName
      email: f['Email'] || '',
      status: f[F.EMP_STATUS] || '',
      role: f[F.EMP_ROLE] || '',
      hasToken: Boolean(f[F.EMP_TOKEN]),
      personalUrl: null,   // убрали, чтобы не дёргать несуществующие поля
      lastInvite:  null
    };
  });

  // Сортировка по имени
  items.sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ru'));

  return json(res, 200, { ok: true, count: items.length, items });
}, { windowMs: 3000, max: 20 });
