// lib/handlers/hr_employees.js
const { json, withRateLimit, atGet, listAll, one, TABLE, F } = require('../utils');

// Помощник: получить запись сотрудника
async function getEmployeeById(id, fields = []) {
  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${id}'`,
    "fields[]": fields,
    maxRecords: 1
  });
  return one(r.records);
}

// Дата последней отправки инвайта (берём из Request Log через Key='invite_email')
async function fetchLastInviteDate(empId) {
  const filter = `AND({${F.RL_KEY}}='invite_email', FIND('${empId}', ARRAYJOIN({${F.RL_EMP}}&""))>0)`;
  const r = await atGet(TABLE.REQLOG, {
    filterByFormula: filter,
    "fields[]": [F.RL_DATE],
    pageSize: 1,
    'sort[0][field]': F.RL_DATE,
    'sort[0][direction]': 'desc'
  });
  const rec = one(r.records);
  return rec?.fields?.[F.RL_DATE] || null;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const hrID  = url.searchParams.get('employeeID');
  const org   = url.searchParams.get('org');
  const token = url.searchParams.get('token');

  if (!hrID || !org || !token) {
    return json(res, 400, { error: 'employeeID, org, token required' });
  }

  // 1) Проверка вызывающего: HR/Manager + та же орг
  const who = await getEmployeeById(hrID, [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE]);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields?.[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields?.[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org) return json(res, 403, { error: 'org mismatch' });
  if (who.fields?.[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  const role = String(who.fields?.[F.EMP_ROLE] || '').toUpperCase();
  const isPriv = role.includes('HR') || role.includes('MANAGER');
  if (!isPriv) return json(res, 403, { error: 'HR/Manager role required' });

  // 2) Список сотрудников этой организации
  // Фильтруем по ссылке на Organization: {OrgID (from Organization)} = org code ИЛИ, если у вас есть явное поле в Employees —
  // можно сделать через Organizations lookup. Здесь воспользуемся тем же значением org в lookup-поле.
  // (Если у Employees хранится именно OrgID (code), замените формулу по месту.)
  const employees = await listAll(TABLE.EMPLOYEES, {
    // Селектим по всем, а фильтрацию сделаем на клиенте по linked orgId (надёжнее при разных схемах)
    "fields[]": [F.EMP_NAME, F.EMP_EMAIL, F.EMP_STATUS, F.EMP_ROLE, F.EMP_TOKEN, F.EMP_ORG_LOOKUP],
    pageSize: 100
  });

  // Оставим только тех, у кого linked org == нужная
  const items = [];
  for (const r of (employees || [])) {
    const f = r.fields || {};
    const linkedOrg = Array.isArray(f[F.EMP_ORG_LOOKUP]) ? f[F.EMP_ORG_LOOKUP][0] : f[F.EMP_ORG_LOOKUP];
    if (linkedOrg !== org && linkedOrg !== whoOrg) continue; // допускаем оба равенства на случай разных формул

    const hasToken = !!f[F.EMP_TOKEN];
    const personalUrl = hasToken
      ? `${process.env.SITE_ORIGIN || `https://${req.headers.host}`}/order?employeeID=${encodeURIComponent(r.id)}&org=${encodeURIComponent(org)}&token=${encodeURIComponent(f[F.EMP_TOKEN])}`
      : null;

    const lastInvite = await fetchLastInviteDate(r.id);

    items.push({
      id: r.id,
      name: f[F.EMP_NAME] || '',
      email: f[F.EMP_EMAIL] || '',
      status: f[F.EMP_STATUS] || '',
      role: f[F.EMP_ROLE] || '',
      hasToken,
      personalUrl,
      lastInvite
    });
  }

  // Сортировка по имени
  items.sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ru'));

  return json(res, 200, { ok: true, count: items.length, items });
}, { windowMs: 4000, max: 20 });
