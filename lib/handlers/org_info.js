// /lib/handlers/org_info.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../utils');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org = url.searchParams.get('org');
  if (!org) return json(res, 400, { error: 'org required' });

  // Подготовим список возможных названий поля
  const fieldCandidates = Array.from(new Set([
    F.ORG_NAME || 'Name',
    'Name', 'Org Name', 'Organization', 'Title', 'Display Name'
  ])).filter(Boolean);

  const params = {
    filterByFormula: `{${F.ORG_ID}}='${org}'`,
    maxRecords: 1,
  };
  // Попросим Airtable вернуть все кандидаты (что есть — то и придёт)
  for (const f of fieldCandidates) params["fields[]"] = [...(params["fields[]"] || []), f];

  const r = await atGet(TABLE.ORGS, params);
  const rec = one(r.records);
  if (!rec) return json(res, 404, { ok: false, error: 'org not found', org });

  // Выберем первое непустое поле из списка
  let name = '';
  for (const f of fieldCandidates) {
    const v = rec.fields?.[f];
    if (typeof v === 'string' && v.trim()) { name = v.trim(); break; }
    if (Array.isArray(v) && v[0]) { name = String(v[0]); break; }
  }
  if (!name) name = org; // запасной вариант

  return json(res, 200, { ok: true, org, name });
}, { windowMs: 4000, max: 20 });
