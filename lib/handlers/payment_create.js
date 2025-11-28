// lib/handlers/payment_create.js — создание платежа

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  PAYMENTS:   env('TBL_PAYMENTS',   'Payments'),
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
  BANKS:      env('TBL_BANKS',      'Banks'),
};

const F = {
  // Employees
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),

  // Organizations
  ORG_ID:         env('FLD_ORG_ID',         'OrgID'),
  ORG_BANK:       env('FLD_ORG_BANK',       'Bank'),

  // Banks
  BANK_ACQUIRING_PROVIDER:   env('FLD_BANK_ACQUIRING_PROVIDER',   'AcquiringProvider'),
  BANK_TERMINAL_ID:          env('FLD_BANK_TERMINAL_ID',          'TerminalID'),
  BANK_MERCHANT_ID:          env('FLD_BANK_MERCHANT_ID',          'MerchantID'),
  BANK_API_KEY:              env('FLD_BANK_API_KEY',              'APIKey'),
  BANK_PAYMENT_PAGE_BASE_URL: env('FLD_BANK_PAYMENT_PAGE_BASE_URL', 'PaymentPageBaseURL'),

  // Payments
  PAY_ORGANIZATION:   env('FLD_PAY_ORGANIZATION',   'Organization'),
  PAY_EMPLOYEE:       env('FLD_PAY_EMPLOYEE',       'Employee'),
  PAY_AMOUNT:         env('FLD_PAY_AMOUNT',         'Amount'),
  PAY_CURRENCY:       env('FLD_PAY_CURRENCY',       'Currency'),
  PAY_STATUS:         env('FLD_PAY_STATUS',         'Status'),
  PAY_PAYMENT_METHOD: env('FLD_PAY_PAYMENT_METHOD', 'PaymentMethod'),
  PAY_PROVIDER:       env('FLD_PAY_PROVIDER',       'Provider'),
  PAY_EXTERNAL_ID:    env('FLD_PAY_EXTERNAL_ID',    'ExternalID'),
  PAY_PAYMENT_LINK:   env('FLD_PAY_PAYMENT_LINK',   'PaymentLink'),
  PAY_ORDERS:         env('FLD_PAY_ORDERS',         'Orders'),

  // Orders
  ORDER_PAYMENT:      env('FLD_ORDER_PAYMENT',      'Payment'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
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

async function atPost(t, body) {
  const r = await fetch(atUrl(t), { method: 'POST', headers: atHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT POST ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPatch(t, body) {
  const r = await fetch(atUrl(t), { method: 'PATCH', headers: atHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a) => (Array.isArray(a) && a.length ? a[0] : null);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(res => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      try { res(d ? JSON.parse(d) : {}); } catch { res({}); }
    });
  });
}

// Заглушка для интеграции с банком (Tinkoff, Sber, Yookassa, etc.)
async function createPaymentAtBank({ provider, terminalId, merchantId, apiKey, amount, currency, orderId, returnUrl }) {
  // TODO: Реальная интеграция с API банка
  // Пример для Tinkoff Acquiring API:
  // const response = await fetch('https://securepay.tinkoff.ru/v2/Init', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     TerminalKey: terminalId,
  //     Amount: amount * 100, // в копейках
  //     OrderId: orderId,
  //     Description: `Оплата обедов`,
  //     // ... другие параметры
  //   })
  // });
  // const data = await response.json();
  // return { externalId: data.PaymentId, paymentLink: data.PaymentURL };

  // Заглушка:
  const externalId = `MOCK_${Date.now()}`;
  const paymentLink = `https://mock-payment.example.com/?orderId=${orderId}&amount=${amount}`;
  
  return { externalId, paymentLink };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    if (!BASE || !APIKEY) return json(res, 500, { error: 'Missing AIRTABLE_* env' });

    const body = await readBody(req);
    const { employeeID, org, token, orderIds, amount, paymentMethod } = body || {};

    if (!employeeID || !org || !token || !orderIds || !amount || !paymentMethod) {
      return json(res, 400, { error: 'employeeID, org, token, orderIds, amount, paymentMethod required' });
    }

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return json(res, 400, { error: 'orderIds must be a non-empty array' });
    }

    // Проверка сотрудника
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      maxRecords: 1,
      'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS],
    });

    const empRec = one(empResp.records);
    if (!empRec) return json(res, 404, { error: 'employee not found' });

    const ef = empRec.fields || {};
    const empOrg = (Array.isArray(ef[F.EMP_ORG_LOOKUP]) ? ef[F.EMP_ORG_LOOKUP][0] : ef[F.EMP_ORG_LOOKUP]) || null;
    if (empOrg !== org) return json(res, 403, { error: 'employee not allowed (org mismatch)' });
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase() !== 'active') {
      return json(res, 403, { error: 'employee not active' });
    }

    // Получаем организацию
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      maxRecords: 1,
      'fields[]': [F.ORG_BANK],
    });

    const orgRec = one(orgResp.records);
    if (!orgRec) return json(res, 404, { error: 'organization not found' });

    const orgFields = orgRec.fields || {};
    const bankLinks = orgFields[F.ORG_BANK];
    if (!bankLinks || !Array.isArray(bankLinks) || bankLinks.length === 0) {
      return json(res, 400, { error: 'organization has no bank configured' });
    }

    const bankId = bankLinks[0];

    // Получаем банк
    const bankResp = await atGet(TABLE.BANKS, {
      filterByFormula: `RECORD_ID()='${bankId}'`,
      maxRecords: 1,
      'fields[]': [
        F.BANK_ACQUIRING_PROVIDER,
        F.BANK_TERMINAL_ID,
        F.BANK_MERCHANT_ID,
        F.BANK_API_KEY,
        F.BANK_PAYMENT_PAGE_BASE_URL,
      ],
    });

    const bankRec = one(bankResp.records);
    if (!bankRec) return json(res, 404, { error: 'bank not found' });

    const bf = bankRec.fields || {};
    const provider = bf[F.BANK_ACQUIRING_PROVIDER] || '';
    const terminalId = bf[F.BANK_TERMINAL_ID] || '';
    const merchantId = bf[F.BANK_MERCHANT_ID] || '';
    const apiKey = bf[F.BANK_API_KEY] || '';

    // Создаём запись в Payments
    const paymentCreate = await atPost(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        fields: {
          [F.PAY_ORGANIZATION]: [orgRec.id],
          [F.PAY_EMPLOYEE]: [employeeID],
          [F.PAY_AMOUNT]: amount,
          [F.PAY_CURRENCY]: 'RUB',
          [F.PAY_STATUS]: 'Pending',
          [F.PAY_PAYMENT_METHOD]: paymentMethod,
          [F.PAY_PROVIDER]: [bankId],
          [F.PAY_ORDERS]: orderIds,
        }
      }]
    });

    const paymentRec = one(paymentCreate.records);
    if (!paymentRec) return json(res, 500, { error: 'payment create failed' });

    const paymentID = paymentRec.id;

    // Если метод оплаты — наличные, не создаём платёжную ссылку
    if (paymentMethod === 'Cash') {
      // Обновляем заказы: привязываем к платежу
      await atPatch(TABLE.ORDERS, {
        typecast: true,
        records: orderIds.map(orderId => ({
          id: orderId,
          fields: { [F.ORDER_PAYMENT]: [paymentID] }
        }))
      });

      return json(res, 200, {
        ok: true,
        paymentID,
        paymentLink: null,
        amount,
        paymentMethod: 'Cash',
      });
    }

    // Создаём платёж в банке (для Online)
    const { externalId, paymentLink } = await createPaymentAtBank({
      provider,
      terminalId,
      merchantId,
      apiKey,
      amount,
      currency: 'RUB',
      orderId: paymentID,
      returnUrl: `${process.env.FRONTEND_URL || 'https://example.com'}/order?org=${org}&employeeID=${employeeID}&token=${token}`,
    });

    // Обновляем Payment: добавляем ExternalID и PaymentLink
    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentID,
        fields: {
          [F.PAY_EXTERNAL_ID]: externalId,
          [F.PAY_PAYMENT_LINK]: paymentLink,
        }
      }]
    });

    // Обновляем заказы: привязываем к платежу
    await atPatch(TABLE.ORDERS, {
      typecast: true,
      records: orderIds.map(orderId => ({
        id: orderId,
        fields: { [F.ORDER_PAYMENT]: [paymentID] }
      }))
    });

    return json(res, 200, {
      ok: true,
      paymentID,
      paymentLink,
      amount,
      externalId,
    });

  } catch (e) {
    console.error('payment_create.js failed:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
