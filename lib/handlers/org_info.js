// lib/handlers/org_info.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../utils');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org = url.searchParams.get('org');
  if (!org) return json(res, 400, { ok: false, error: 'org required' });

  // Ищем организацию по OrgID
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${org.replace(/'/g, "\\'")}'`,
    maxRecords: 1,
    'fields[]': [
      F.ORG_NAME,
      F.ORG_VID_DOG,
      F.ORG_PRICE_FULL,
      F.ORG_PRICE_LIGHT,
    ]
  });

  const rec = one(r.records);
  if (!rec) return json(res, 404, { ok: false, error: 'org not found', org });

  const fields = rec.fields || {};
  const orgData = {
    name: String(fields[F.ORG_NAME] || '').trim() || org,
    vidDogovora: fields[F.ORG_VID_DOG] || 'Standard',
    priceFull: fields[F.ORG_PRICE_FULL] || null,
    priceLight: fields[F.ORG_PRICE_LIGHT] || null,
    bankName: null,
    bankINN: null,
    bankKPP: null,
    bankAccount: null,
    bankBIK: null,
    bankCorrespondent: null,
  };

  return json(res, 200, { ok: true, org: orgData });
}, { windowMs: 4000, max: 20 });
