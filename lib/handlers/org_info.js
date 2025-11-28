// lib/handlers/org_info.js
const Airtable = require('airtable');
const url = require('url');

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;

if (!BASE_ID || !API_KEY) {
  throw new Error('Missing AIRTABLE_BASE_ID or AIRTABLE_API_KEY');
}

const base = new Airtable({ apiKey: API_KEY }).base(BASE_ID);

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(data));
}

module.exports = async function orgInfoHandler(req, res) {
  try {
    const parsed = url.parse(req.url, true);
    const { org } = parsed.query;

    if (!org) {
      return sendJson(res, 400, { ok: false, error: 'Missing org parameter' });
    }

    // Ищем организацию по полю Name
    const records = await base('Organizations')
      .select({
        filterByFormula: `{Name} = '${org.replace(/'/g, "\\'")}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (!records || records.length === 0) {
      return sendJson(res, 404, { ok: false, error: 'Organization not found' });
    }

    const rec = records[0];
    const fields = rec.fields;

    const orgData = {
      id: rec.id,
      name: fields.Name || org,
      vidDogovora: fields.vidDogovora || 'Standard',
      priceFull: fields.PriceFull || null,
      priceLight: fields.PriceLight || null,
      bankName: fields.BankName || null,
      bankINN: fields.BankINN || null,
      bankKPP: fields.BankKPP || null,
      bankAccount: fields.BankAccount || null,
      bankBIK: fields.BankBIK || null,
      bankCorrespondent: fields.BankCorrespondent || null,
    };

    return sendJson(res, 200, { ok: true, org: orgData });
  } catch (e) {
    console.error('[org_info] Error:', e);
    return sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
};
