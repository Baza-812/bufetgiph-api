// lib/handlers/org_info.js
const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const ORGS_TABLE = 'Organizations';
const BANKS_TABLE = 'Banks';

module.exports = async function orgInfoHandler(req, res) {
  const { org } = req.query;

  if (!org) {
    return res.status(400).json({ ok: false, error: 'Missing org parameter' });
  }

  try {
    // Ищем организацию по OrgID
    const orgRecords = await base(ORGS_TABLE)
      .select({
        filterByFormula: `{OrgID} = '${org}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (orgRecords.length === 0) {
      return res.status(404).json({ ok: false, error: 'Organization not found' });
    }

    const orgRec = orgRecords[0];

    // Читаем основные поля организации
    const name = orgRec.get('Name') || '';
    const vidDogovora = orgRec.get('vidDogovora') || null;
    const priceFull = orgRec.get('PriceFull') || null;
    const priceLight = orgRec.get('PriceLight') || null;

    // Читаем связь с Banks (link-поле)
    const bankLinks = orgRec.get('Bank'); // массив RecID из таблицы Banks
    let footerText = null;

    if (bankLinks && bankLinks.length > 0) {
      try {
        const bankRecId = bankLinks[0]; // берём первую связанную запись
        const bankRec = await base(BANKS_TABLE).find(bankRecId);
        footerText = bankRec.get('FooterText') || null;
      } catch (e) {
        console.error('Failed to fetch Bank record:', e);
        // Если не удалось получить Banks — продолжаем без футера
      }
    }

    return res.status(200).json({
      ok: true,
      org: {
        name,
        vidDogovora,
        priceFull,
        priceLight,
        footerText,
      },
    });
  } catch (error) {
    console.error('org_info error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Internal server error',
    });
  }
};
