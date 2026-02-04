// lib/handlers/org_info.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../../lib/utils'); // ВАЖНО: '../../lib/utils'

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org = url.searchParams.get('org');
  if (!org) return json(res, 400, { ok:false, error: 'org required' });

  // F.ORG_ID = 'OrgID' (см. lib/utils.js), F.ORG_NAME = 'Name', F.ORG_PORTION = 'Main Portion Type'
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${org}'`,
    maxRecords: 1,
    "fields[]": [F.ORG_NAME, F.ORG_PORTION]
  });

  const rec = one(r.records);
  if (!rec) return json(res, 404, { ok:false, error: 'org not found', org });

  const name = String(rec.fields?.[F.ORG_NAME] || '').trim() || org;
  const portionType = String(rec.fields?.[F.ORG_PORTION] || 'Standard').trim();

  return json(res, 200, { ok:true, org, name, portionType });
}, { windowMs: 4000, max: 20 });
