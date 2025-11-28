// lib/handlers/org_meta.js — метаданные организации для программы "Старший"

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORGS:  env('TBL_ORGS',  'Organizations'),
  BANKS: env('TBL_BANKS', 'Banks'),
};

const F = {
  // Organizations
  ORG_ID:                    env('FLD_ORG_ID',                    'OrgID'),
  ORG_VID_DOGOVORA:          env('FLD_ORG_VID_DOGOVORA',          'VidDogovora'),
  ORG_MIN_TEAM_SIZE:         env('FLD_ORG_MIN_TEAM_SIZE',         'MinTeamSize'),
  ORG_FREE_DELIVERY_MIN:     env('FLD_ORG_FREE_DELIVERY_MIN',     'FreeDeliveryMinOrders'),
  ORG_PRICE_FULL:            env('FLD_ORG_PRICE_FULL',            'PriceFull'),
  ORG_PRICE_LIGHT:           env('FLD_ORG_PRICE_LIGHT',           'PriceLight'),
  ORG_BANK:                  env('FLD_ORG_BANK',                  'Bank'),

  // Banks
  BANK_NAME:                 env('FLD_BANK_NAME',                 'Name'),
  BANK_LEGAL_NAME:           env('FLD_BANK_LEGAL_NAME',           'LegalName'),
  BANK_BANK_NAME:            env('FLD_BANK_BANK_NAME',            'BankName'),
  BANK_INN:                  env('FLD_BANK_INN',                  'INN'),
  BANK_KPP:                  env('FLD_BANK_KPP',                  'KPP'),
  BANK_ACCOUNT:              env('FLD_BANK_ACCOUNT',              'Account'),
  BANK_BIC:                  env('FLD_BANK_BIC',                  'BIC'),
  BANK_CONTACT_PHONE:        env('FLD_BANK_CONTACT_PHONE',        'ContactPhone'),
  BANK_CONTACT_EMAIL:        env('FLD_BANK_CONTACT_EMAIL',        'ContactEmail'),
  BANK_FOOTER_TEXT:          env('FLD_BANK_FOOTER_TEXT',          'FooterText'),
  BANK_ACQUIRING_PROVIDER:   env('FLD_BANK_ACQUIRING_PROVIDER',   'AcquiringProvider'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

const atHeaders = () => ({ Authorization: `Bearer ${APIKEY}`, 'Content-Type': 'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(t, params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(vv => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a) => (Array.isArray(a) && a.length ? a[0] : null);

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    if (!BASE || !APIKEY) return json(res, 500, { error: 'Missing AIRTABLE_* env' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');

    if (!org) return json(res, 400, { error: 'org required' });

    // Получаем организацию
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      maxRecords: 1,
      'fields[]': [
        F.ORG_VID_DOGOVORA,
        F.ORG_MIN_TEAM_SIZE,
        F.ORG_FREE_DELIVERY_MIN,
        F.ORG_PRICE_FULL,
        F.ORG_PRICE_LIGHT,
        F.ORG_BANK,
      ],
    });

    const orgRec = one(orgResp.records);
    if (!orgRec) return json(res, 404, { error: 'organization not found' });

    const of = orgRec.fields || {};

    const vidDogovora = of[F.ORG_VID_DOGOVORA] || 'Contract';
    const minTeamSize = of[F.ORG_MIN_TEAM_SIZE] || null;
    const freeDeliveryMinOrders = of[F.ORG_FREE_DELIVERY_MIN] || null;
    const priceFull = of[F.ORG_PRICE_FULL] || null;
    const priceLight = of[F.ORG_PRICE_LIGHT] || null;

    // Если VidDogovora !== 'Starshiy', возвращаем минимальный ответ
    if (vidDogovora !== 'Starshiy') {
      return json(res, 200, {
        ok: true,
        vidDogovora,
        minTeamSize: null,
        freeDeliveryMinOrders: null,
        priceFull: null,
        priceLight: null,
        bank: null,
      });
    }

    // Получаем банк (если есть)
    let bankData = null;
    const bankLinks = of[F.ORG_BANK];
    if (bankLinks && Array.isArray(bankLinks) && bankLinks.length > 0) {
      const bankId = bankLinks[0];
      const bankResp = await atGet(TABLE.BANKS, {
        filterByFormula: `RECORD_ID()='${bankId}'`,
        maxRecords: 1,
        'fields[]': [
          F.BANK_NAME,
          F.BANK_LEGAL_NAME,
          F.BANK_BANK_NAME,
          F.BANK_INN,
          F.BANK_KPP,
          F.BANK_ACCOUNT,
          F.BANK_BIC,
          F.BANK_CONTACT_PHONE,
          F.BANK_CONTACT_EMAIL,
          F.BANK_FOOTER_TEXT,
          F.BANK_ACQUIRING_PROVIDER,
        ],
      });

      const bankRec = one(bankResp.records);
      if (bankRec) {
        const bf = bankRec.fields || {};
        bankData = {
          name: bf[F.BANK_NAME] || '',
          legalName: bf[F.BANK_LEGAL_NAME] || '',
          bankName: bf[F.BANK_BANK_NAME] || '',
          inn: bf[F.BANK_INN] || '',
          kpp: bf[F.BANK_KPP] || '',
          account: bf[F.BANK_ACCOUNT] || '',
          bic: bf[F.BANK_BIC] || '',
          contactPhone: bf[F.BANK_CONTACT_PHONE] || '',
          contactEmail: bf[F.BANK_CONTACT_EMAIL] || '',
          footerText: bf[F.BANK_FOOTER_TEXT] || '',
          acquiringProvider: bf[F.BANK_ACQUIRING_PROVIDER] || '',
        };
      }
    }

    return json(res, 200, {
      ok: true,
      vidDogovora,
      minTeamSize,
      freeDeliveryMinOrders,
      priceFull,
      priceLight,
      bank: bankData,
    });

  } catch (e) {
    console.error('org_meta.js failed:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
