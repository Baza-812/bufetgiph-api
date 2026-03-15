// lib/handlers/payment_create.js
// Создание платежа в ЮKassa для оплаты платных дополнительных блюд

const { json, atGet, atPost, atPatch, one, TABLE, F } = require('../utils');
const crypto = require('crypto');

function env(k, d) { return process.env[k] ?? d; }

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3/payments';
const RETURN_URL_BASE = env('PAYMENT_RETURN_URL', 'https://orders.baza.menu/payment/result');

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } 
      catch { resolve({}); }
    });
  });
}

// Получить Bank credentials (из Airtable или ENV)
async function getBankCredentials(bankRecordId) {
  const bankResp = await atGet(TABLE.BANKS, {
    filterByFormula: `RECORD_ID()='${bankRecordId}'`,
    'fields[]': [
      F.BANK_MERCHANT_ID,
      F.BANK_API_KEY,
      F.BANK_ENV_PREFIX,
      F.BANK_CREDS_SOURCE,
      F.BANK_PROVIDER,
      F.BANK_IS_ACTIVE,
      F.BANK_LEGAL_NAME,
      F.BANK_INN,
      F.BANK_KPP,
      F.BANK_FOOTER,
    ],
    maxRecords: 1
  });

  const bank = one(bankResp.records);
  if (!bank) throw new Error('Bank not found');
  if (!bank.fields?.[F.BANK_IS_ACTIVE]) throw new Error('Bank is not active');

  const provider = bank.fields?.[F.BANK_PROVIDER];
  if (provider !== 'YOOKASSA') throw new Error(`Unsupported provider: ${provider}`);

  const source = bank.fields?.[F.BANK_CREDS_SOURCE];
  let shopId, secretKey;

  if (source === 'ENV') {
    // Берем из переменных окружения
    const prefix = bank.fields?.[F.BANK_ENV_PREFIX] || 'YOOKASSA';
    shopId = process.env[`${prefix}_SHOP_ID`];
    secretKey = process.env[`${prefix}_SECRET_KEY`];
  } else {
    // Берем из Airtable
    shopId = bank.fields?.[F.BANK_MERCHANT_ID];
    secretKey = bank.fields?.[F.BANK_API_KEY];
  }

  if (!shopId || !secretKey) {
    throw new Error('Missing YooKassa credentials');
  }

  return {
    shopId,
    secretKey,
    legalName: bank.fields?.[F.BANK_LEGAL_NAME] || '',
    inn: bank.fields?.[F.BANK_INN] || '',
    kpp: bank.fields?.[F.BANK_KPP] || '',
    footer: bank.fields?.[F.BANK_FOOTER] || '',
    bankRecordId,
  };
}

module.exports = async (req, res) => {
  try {
    console.log('[payment_create] Starting...');
    
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    const body = await readBody(req);
    console.log('[payment_create] Body:', JSON.stringify(body));
    
    const { orderId, employeeID, org, token, amount, description } = body || {};

    if (!orderId || !employeeID || !org || !token) {
      console.log('[payment_create] Missing required fields');
      return json(res, 400, { error: 'orderId, employeeID, org, token required' });
    }

    if (!amount || amount <= 0) {
      console.log('[payment_create] Invalid amount:', amount);
      return json(res, 400, { error: 'amount must be positive' });
    }
    
    console.log('[payment_create] Checking employee...');

    // 1) Проверяем сотрудника и организацию
    let empResp;
    try {
      empResp = await atGet(TABLE.EMPLOYEES, {
        filterByFormula: `RECORD_ID()='${employeeID}'`,
        'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS, F.EMP_NAME],
        maxRecords: 1
      });
    } catch (e) {
      console.error('[payment_create] Failed to fetch employee:', e);
      return json(res, 500, { ok: false, error: 'Failed to fetch employee: ' + e.message });
    }
    
    const emp = one(empResp.records);
    if (!emp) {
      console.log('[payment_create] Employee not found:', employeeID);
      return json(res, 404, { ok: false, error: 'Employee not found' });
    }
    
    console.log('[payment_create] Employee found:', emp.id);

    const empOrg = (Array.isArray(emp.fields?.[F.EMP_ORG_LOOKUP]) 
      ? emp.fields[F.EMP_ORG_LOOKUP][0] 
      : emp.fields?.[F.EMP_ORG_LOOKUP]) || null;
    
    if (empOrg !== org) return json(res, 403, { error: 'Organization mismatch' });
    if (emp.fields?.[F.EMP_TOKEN] !== token) return json(res, 403, { error: 'Invalid token' });
    if (emp.fields?.[F.EMP_STATUS] && String(emp.fields[F.EMP_STATUS]).toLowerCase() !== 'active') {
      return json(res, 403, { error: 'Employee not active' });
    }

    const empName = emp.fields?.[F.EMP_NAME] || '';
    console.log('[payment_create] Employee name:', empName);

    // 2) Получаем Organization и Bank
    console.log('[payment_create] Fetching organization:', org);
    
    let orgResp;
    try {
      orgResp = await atGet(TABLE.ORGS, {
        filterByFormula: `{${F.ORG_ID}}='${org}'`,
        'fields[]': [F.ORG_NAME, F.ORG_BANK],
        maxRecords: 1
      });
    } catch (e) {
      console.error('[payment_create] Failed to fetch organization:', e);
      return json(res, 500, { ok: false, error: 'Failed to fetch organization: ' + e.message });
    }
    
    const orgRec = one(orgResp.records);
    if (!orgRec) {
      console.log('[payment_create] Organization not found:', org);
      return json(res, 404, { ok: false, error: 'Organization not found' });
    }
    
    console.log('[payment_create] Organization found:', orgRec.id);

    const orgName = orgRec.fields?.[F.ORG_NAME] || org;
    const bankLinks = orgRec.fields?.[F.ORG_BANK];
    const bankRecordId = Array.isArray(bankLinks) ? bankLinks[0] : bankLinks;
    
    console.log('[payment_create] Organization Bank links:', bankLinks);
    console.log('[payment_create] Bank Record ID:', bankRecordId);
    
    if (!bankRecordId) {
      console.log('[payment_create] No Bank configured for organization');
      return json(res, 400, { ok: false, error: 'Organization has no Bank configured' });
    }

    // 3) Получаем Bank credentials
    console.log('[payment_create] Getting bank credentials...');
    let creds;
    try {
      creds = await getBankCredentials(bankRecordId);
      console.log('[payment_create] Bank credentials obtained, provider:', creds.shopId ? 'configured' : 'missing');
    } catch (e) {
      console.error('[payment_create] Failed to get bank credentials:', e);
      return json(res, 500, { ok: false, error: 'Failed to get bank credentials: ' + e.message });
    }

    // 4) Проверяем Order
    const orderResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      'fields[]': [F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_PAYMENT],
      maxRecords: 1
    });
    const order = one(orderResp.records);
    if (!order) return json(res, 404, { error: 'Order not found' });

    // Проверяем, что заказ принадлежит этому сотруднику
    const orderEmpId = Array.isArray(order.fields?.[F.ORDER_EMPLOYEE])
      ? order.fields[F.ORDER_EMPLOYEE][0]
      : order.fields?.[F.ORDER_EMPLOYEE];
    
    if (orderEmpId !== employeeID) {
      return json(res, 403, { error: 'Order does not belong to this employee' });
    }

    // Проверяем, нет ли уже оплаченного платежа
    const existingPaymentLinks = order.fields?.[F.ORDER_PAYMENT];
    if (existingPaymentLinks && existingPaymentLinks.length > 0) {
      // Проверим статус существующего платежа
      const existingPaymentId = Array.isArray(existingPaymentLinks) 
        ? existingPaymentLinks[0] 
        : existingPaymentLinks;
      
      const existingPaymentResp = await atGet(TABLE.PAYMENTS, {
        filterByFormula: `RECORD_ID()='${existingPaymentId}'`,
        'fields[]': [F.PAYMENT_STATUS, F.PAYMENT_LINK, F.PAYMENT_EXTERNAL_ID],
        maxRecords: 1
      });
      
      const existingPayment = one(existingPaymentResp.records);
      if (existingPayment) {
        const status = existingPayment.fields?.[F.PAYMENT_STATUS];
        if (status === 'succeeded') {
          return json(res, 400, { error: 'Order already paid' });
        }
        if (status === 'pending') {
          // Возвращаем существующий payment link
          return json(res, 200, {
            ok: true,
            paymentUrl: existingPayment.fields?.[F.PAYMENT_LINK],
            paymentId: existingPayment.fields?.[F.PAYMENT_EXTERNAL_ID],
          });
        }
      }
    }

    // 5) Создаем запись Payment в Airtable
    const paymentCreateResp = await atPost(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        fields: {
          [F.PAYMENT_ORDERS]: [orderId],
          [F.PAYMENT_EMPLOYEE]: [employeeID],
          [F.PAYMENT_ORG]: [orgRec.id],
          [F.PAYMENT_PROVIDER]: [bankRecordId],
          [F.PAYMENT_AMOUNT]: amount,
          [F.PAYMENT_CURRENCY]: 'RUB',
          [F.PAYMENT_STATUS]: 'pending',
          [F.PAYMENT_NOTES]: description || `Оплата доп. блюд к заказу`,
        }
      }]
    });

    const paymentRecord = one(paymentCreateResp.records);
    if (!paymentRecord) throw new Error('Failed to create Payment record');
    const paymentRecordId = paymentRecord.id;

    // 6) Создаем платеж в ЮKassa
    const idempotenceKey = crypto.randomUUID();
    const returnUrl = `${RETURN_URL_BASE}?paymentId=${paymentRecordId}&orderId=${orderId}`;

    const yookassaPayload = {
      amount: {
        value: amount.toFixed(2),
        currency: 'RUB'
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: returnUrl
      },
      description: description || `Доп. блюда к заказу для ${empName}`,
      metadata: {
        orderId,
        employeeID,
        org,
        paymentRecordId,
      }
    };

    const authHeader = 'Basic ' + Buffer.from(`${creds.shopId}:${creds.secretKey}`).toString('base64');
    
    const yookassaResp = await fetch(YOOKASSA_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(yookassaPayload)
    });

    if (!yookassaResp.ok) {
      const errorText = await yookassaResp.text();
      throw new Error(`YooKassa API error: ${yookassaResp.status} ${errorText}`);
    }

    const yookassaPayment = await yookassaResp.json();

    // 7) Обновляем Payment record с данными от ЮKassa
    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentRecordId,
        fields: {
          [F.PAYMENT_EXTERNAL_ID]: yookassaPayment.id,
          [F.PAYMENT_LINK]: yookassaPayment.confirmation?.confirmation_url || '',
          [F.PAYMENT_STATUS]: yookassaPayment.status || 'pending',
        }
      }]
    });

    // 8) Линкуем Order → Payment
    await atPatch(TABLE.ORDERS, {
      typecast: true,
      records: [{
        id: orderId,
        fields: {
          [F.ORDER_PAYMENT]: [paymentRecordId],
        }
      }]
    });

    // 9) Возвращаем URL для редиректа
    return json(res, 200, {
      ok: true,
      paymentUrl: yookassaPayment.confirmation?.confirmation_url,
      paymentId: yookassaPayment.id,
      paymentRecordId,
    });

  } catch (err) {
    console.error('[payment_create] ERROR:', err);
    console.error('[payment_create] Stack:', err.stack);
    
    // Важно: всегда возвращаем JSON, даже при ошибке
    return json(res, 500, { 
      ok: false,
      error: err.message || 'Payment creation failed',
      details: process.env.DEBUG_ROUTES === 'on' ? err.stack : undefined
    });
  }
};
