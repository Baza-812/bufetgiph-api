const { ORG_ID, ORG_NAME, ORG_VID_DOGOVORA, ORG_BANK, ORG_CUTOFF_TIME, ORG_PRICE_FULL, ORG_PRICE_LIGHT } = require('../utils');

async function orgInfoHandler(req, res) {
  const { orgId, employeeId } = req.query;

  if (!orgId) {
    return res.status(400).json({ ok: false, error: 'orgId required' });
  }

  try {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.AIRTABLE_BASE_ID;

    // Fetch organization
    const orgUrl = `https://api.airtable.com/v0/${BASE_ID}/Organizations?filterByFormula={${ORG_ID}}='${orgId}'`;
    const orgResponse = await fetch(orgUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    const orgData = await orgResponse.json();

    console.log('🔍 org_info: orgData =', JSON.stringify(orgData, null, 2));

    if (!orgData.records || orgData.records.length === 0) {
      return res.status(404).json({ ok: false, error: 'Organization not found' });
    }

    const orgRecord = orgData.records[0];
    const orgName = orgRecord.fields[ORG_NAME] || '';
    const vidDogovora = orgRecord.fields[ORG_VID_DOGOVORA] || '';
    const cutoffTime = orgRecord.fields[ORG_CUTOFF_TIME] || '18:00';
    const priceFull = orgRecord.fields[ORG_PRICE_FULL] || null;
    const priceLight = orgRecord.fields[ORG_PRICE_LIGHT] || null;
    const bankIds = orgRecord.fields[ORG_BANK];

    console.log('🔍 org_info: vidDogovora =', vidDogovora, 'priceFull =', priceFull, 'priceLight =', priceLight);

    // Fetch footer text from Banks table
    let footerText = null;
    if (bankIds && bankIds.length > 0) {
      const bankId = bankIds[0];
      const bankUrl = `https://api.airtable.com/v0/${BASE_ID}/Banks/${bankId}`;
      const bankResponse = await fetch(bankUrl, {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
      });
      const bankData = await bankResponse.json();
      footerText = bankData.fields?.FooterText || null;
    }

    // Fetch employee name if employeeId provided
    let employeeName = null;
    if (employeeId) {
      const empUrl = `https://api.airtable.com/v0/${BASE_ID}/Employees?filterByFormula={EmployeeID}='${employeeId}'`;
      const empResponse = await fetch(empUrl, {
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
      });
      const empData = await empResponse.json();
      console.log('🔍 org_info: empData =', JSON.stringify(empData, null, 2));
      if (empData.records && empData.records.length > 0) {
        employeeName = empData.records[0].fields.Name || null;
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

    return res.json(result);
  } catch (error) {
    console.error('❌ org_info error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = orgInfoHandler;
