// lib/handlers/org_info.js
const { json, withRateLimit, atGet, one, TABLE, F, BASE, APIKEY } = require('../utils');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const org = url.searchParams.get('org');
  const employeeId = url.searchParams.get('employeeId');
  
  if (!org) return json(res, 400, { ok: false, error: 'org required' });

  try {
    // Fetch organization
    const orgResult = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      maxRecords: 1
    });

    console.log('🔍 org_info: orgResult =', JSON.stringify(orgResult, null, 2));

    const orgRec = one(orgResult.records);
    if (!orgRec) return json(res, 404, { ok: false, error: 'org not found', org });

    const orgName = orgRec.fields[F.ORG_NAME] || '';
    const vidDogovora = orgRec.fields[F.ORG_VID_DOGOVORA] || '';
    const priceFull = orgRec.fields[F.ORG_PRICE_FULL] || null;
    const priceLight = orgRec.fields[F.ORG_PRICE_LIGHT] || null;
    const cutoffTime = orgRec.fields[F.ORG_CUTOFF_TIME] || '22:00';
    const bankIds = orgRec.fields[F.ORG_BANK];

    console.log('🔍 org_info: vidDogovora =', vidDogovora, 'priceFull =', priceFull, 'priceLight =', priceLight);

    // Fetch footer text from Banks table
    let footerText = null;
    if (bankIds && Array.isArray(bankIds) && bankIds.length > 0) {
      const bankId = bankIds[0];
      const bankUrl = `https://api.airtable.com/v0/${BASE}/Banks/${bankId}`;
      const bankResponse = await fetch(bankUrl, {
        headers: { Authorization: `Bearer ${APIKEY}` }
      });
      if (bankResponse.ok) {
        const bankData = await bankResponse.json();
        footerText = bankData.fields?.FooterText || null;
      }
    }

    // Fetch employee name if employeeId provided
    let employeeName = null;
    if (employeeId) {
      const empResult = await atGet(TABLE.EMPLOYEES, {
        filterByFormula: `RECORD_ID()='${employeeId}'`,
        maxRecords: 1
      });
      console.log('🔍 org_info: empResult =', JSON.stringify(empResult, null, 2));
      const empRec = one(empResult.records);
      if (empRec) {
        employeeName = empRec.fields[F.EMP_NAME] || null;
      }
    }

    const result = {
      ok: true,
      org: {
        name: orgName,
        vidDogovora,
        cutoffTime,
        footerText,
        employeeName,
        priceFull,
        priceLight
      }
    };

    console.log('✅ org_info: result =', JSON.stringify(result, null, 2));

    return json(res, 200, result);
  } catch (error) {
    console.error('❌ org_info error:', error);
    return json(res, 500, { ok: false, error: error.message });
  }
}, { windowMs: 4000, max: 20 });
