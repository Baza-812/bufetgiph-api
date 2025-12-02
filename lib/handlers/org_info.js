// lib/handlers/org_info.js
const { json, withRateLimit, atGet, one, TABLE, F, BASE, APIKEY } = require('../utils');
const Airtable = require('airtable');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org = url.searchParams.get('org');
  if (!org) return json(res, 400, { ok: false, error: 'org required' });

  console.log('🔍 org_info: searching for org:', org);

  // Ищем организацию по OrgID
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${org.replace(/'/g, "\\'")}'`,
    maxRecords: 1,
  });

  const rec = one(r.records);
  if (!rec) {
    console.log('❌ org not found:', org);
    return json(res, 404, { ok: false, error: 'org not found', org });
  }

  console.log('✅ org record found:', rec.id);
  console.log('📋 org fields:', rec.fields);

  const fields = rec.fields || {};
  
  // Bank — link-поле
  const bankLinks = fields[F.ORG_BANK] || fields['Bank']; // пробуем оба варианта
  console.log('🔗 Bank links:', bankLinks);
  
  // Получаем информацию о банке
  let footerText = null;
  if (bankLinks && Array.isArray(bankLinks) && bankLinks.length > 0) {
    try {
      const bankRecId = bankLinks[0];
      console.log('🏦 Fetching bank record:', bankRecId);
      
      const base = new Airtable({ apiKey: APIKEY }).base(BASE);
      const bankRec = await base(TABLE.BANKS).find(bankRecId);
      
      console.log('✅ Bank record found:', bankRec.id);
      console.log('📋 Bank fields:', bankRec.fields);
      
      footerText = bankRec.get(F.BANK_FOOTER) || bankRec.get('FooterText') || null;
      console.log('📄 FooterText:', footerText);
    } catch (e) {
      console.error('❌ Failed to fetch Bank record:', e);
    }
  } else {
    console.log('⚠️ No bank links found');
  }

  const orgData = {
    name: String(fields[F.ORG_NAME] || '').trim() || org,
    vidDogovora: fields[F.ORG_VID_DOG] || 'Standard',
    priceFull: fields[F.ORG_PRICE_FULL] || null,
    priceLight: fields[F.ORG_PRICE_LIGHT] || null,
    footerText: footerText,
  };

  console.log('📦 Final orgData:', orgData);

  return json(res, 200, { ok: true, org: orgData });
}, { windowMs: 4000, max: 20 });
