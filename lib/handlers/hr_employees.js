// lib/handlers/hr_employees.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../utils');

function getOne(val) {
  if (Array.isArray(val)) return val[0];
  return val ?? null;
}

async function getEmployeeById(id, fields = []) {
  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${id}'`,
    "fields[]": fields,
    maxRecords: 1
  });
  return one(r.records);
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org   = url.searchParams.get('org');
  const meId  = url.searchParams.get('employeeID');
  const token = url.searchParams.get('token');

  if (!org || !meId || !token) {
    return json(res, 400, { error: 'org, employeeID, token required' });
  }

  // 1) Проверяем вызывающего
  const me = await getEmployeeById(meId, [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE, F.EMP_NAME]);
  if (!me) return json(res, 404, { error: 'employee not found' });

  const meOrg = getOne(me.fields?.[F.EMP_ORG_LOOKUP]);
  if (meOrg !== org) return json(res, 403, { error: 'org mismatch' });
  if ((me.fields?.[F.EMP_TOKEN] || '') !== token) return json(res, 403, { error: 'invalid token' });

  const isHR = String(me.fields?.[F.EMP_ROLE] || '').toUpperCase().includes('HR');
  if (!isHR) return json(res, 403, { error: 'HR role required' });

  // 2) Список активных сотрудников этой организации
  const filter = `
    AND(
      {${F.EMP_STATUS}}='Active',
      ${F.EMP_ORG_LOOKUP ? `{${F.EMP_ORG_LOOKUP}}='${org}'` : '1'}
    )`.trim();

  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: filter,
    "fields[]": [F.EMP_NAME, F.EMP_EMAIL, F.EMP_STATUS, F.EMP_ROLE, F.EMP_ORG_LOOKUP],
    pageSize: 100
  });

  const items = (r.records || []).map(rec => {
    const f = rec.fields || {};
    return {
      id: rec.id,
      fullName: f[F.EMP_NAME] || '',
      email: f[F.EMP_EMAIL] || '',
      status: f[F.EMP_STATUS] || '',
      role:   f[F.EMP_ROLE] || '',
    };
  });

  return json(res, 200, { ok: true, count: items.length, items });
}, { windowMs: 4000, max: 20 });
