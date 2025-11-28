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
      'Bank', // ← link-поле, вернёт массив RecID
    ]
  });

  const rec = one(r.records);
  if (!rec) return json(res, 404, { ok: false, error: 'org not found', org });

  const fields = rec.fields || {};
  
  // Bank теперь возвращает массив RecID: ["recXXXXXXXXXXXXXX"]
  const bankLinks = fields['Bank']; // или fields[F.ORG_BANK] если добавишь константу
  
  // Получаем информацию о банке
  let footerText = null;
  if (bankLinks && Array.isArray(bankLinks) && bankLinks.length > 0) {
    try {
      const bankRecId = bankLinks[0]; // берём первую связанную запись
      
      // Запрашиваем запись из Banks по RecID напрямую
      const Airtable = require('airtable');
      const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
        process.env.AIRTABLE_BASE_ID
      );
      
      const bankRec = await base(TABLE.BANKS).find(bankRecId);
      footerText = bankRec.get(F.BANK_FOOTER) || null;
    } catch (e) {
      console.error('Failed to fetch Bank record:', e);
      // Продолжаем без футера
    }
  }

  const orgData = {
    name: String(fields[F.ORG_NAME] || '').trim() || org,
    vidDogovora: fields[F.ORG_VID_DOG] || 'Standard',
    priceFull: fields[F.ORG_PRICE_FULL] || null,
    priceLight: fields[F.ORG_PRICE_LIGHT] || null,
    footerText: footerText,
  };

  return json(res, 200, { ok: true, org: orgData });
}, { windowMs: 4000, max: 20 });
