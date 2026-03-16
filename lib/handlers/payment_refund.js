// lib/handlers/payment_refund.js
// Создание возврата платежа в ЮKassa

const { json, atGet, atPost, atPatch, one, TABLE, F } = require('../utils');
const crypto = require('crypto');

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3/refunds';

async function getBankCredentials(bankRecordId) {
  const bankResp = await atGet(TABLE.BANKS, {
    filterByFormula: `RECORD_ID()='${bankRecordId}'`,
    'fields[]': [
      F.BANK_MERCHANT_ID,
      F.BANK_API_KEY,
      F.BANK_ENV_PREFIX,
      F.BANK_CREDS_SOURCE,
    ],
    maxRecords: 1
  });

  const bank = one(bankResp.records);
  if (!bank) return null;

  const source = bank.fields?.[F.BANK_CREDS_SOURCE];
  let shopId, secretKey;

  if (source === 'ENV') {
    const prefix = bank.fields?.[F.BANK_ENV_PREFIX] || 'YOOKASSA';
    shopId = process.env[`${prefix}_SHOP_ID`];
    secretKey = process.env[`${prefix}_SECRET_KEY`];
  } else {
    shopId = bank.fields?.[F.BANK_MERCHANT_ID];
    secretKey = bank.fields?.[F.BANK_API_KEY];
  }

  return shopId && secretKey ? { shopId, secretKey } : null;
}

// Создать возврат для платежа
async function createRefund(paymentRecordId) {
  try {
    console.log('[payment_refund] Processing payment:', paymentRecordId);

    // Получаем Payment
    const paymentResp = await atGet(TABLE.PAYMENTS, {
      filterByFormula: `RECORD_ID()='${paymentRecordId}'`,
      'fields[]': [
        F.PAYMENT_EXTERNAL_ID,
        F.PAYMENT_STATUS,
        F.PAYMENT_PROVIDER,
        F.PAYMENT_AMOUNT,
      ],
      maxRecords: 1
    });

    const payment = one(paymentResp.records);
    if (!payment) {
      console.log('[payment_refund] Payment not found');
      return { ok: false, error: 'Payment not found' };
    }

    const status = payment.fields?.[F.PAYMENT_STATUS];
    const externalId = payment.fields?.[F.PAYMENT_EXTERNAL_ID];
    const amount = payment.fields?.[F.PAYMENT_AMOUNT] || 0;

    // Возврат возможен только для succeeded платежей
    if (status !== 'succeeded') {
      console.log('[payment_refund] Payment not succeeded, status:', status);
      return { ok: true, message: 'Payment not succeeded, no refund needed' };
    }

    if (!externalId) {
      return { ok: false, error: 'Payment has no external ID' };
    }

    // Получаем bank credentials
    const providerLink = payment.fields?.[F.PAYMENT_PROVIDER];
    const bankRecordId = Array.isArray(providerLink) ? providerLink[0] : providerLink;
    
    if (!bankRecordId) {
      return { ok: false, error: 'Payment has no provider' };
    }

    const creds = await getBankCredentials(bankRecordId);
    if (!creds) {
      return { ok: false, error: 'Failed to get bank credentials' };
    }

    // Создаем возврат в ЮKassa
    const idempotenceKey = crypto.randomUUID();
    const refundPayload = {
      payment_id: externalId,
      amount: {
        value: amount.toFixed(2),
        currency: 'RUB'
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
      body: JSON.stringify(refundPayload)
    });

    if (!yookassaResp.ok) {
      const errorText = await yookassaResp.text();
      console.error('[payment_refund] YooKassa API error:', errorText);
      return { ok: false, error: `YooKassa API error: ${yookassaResp.status}` };
    }

    const refund = await yookassaResp.json();
    console.log('[payment_refund] Refund created:', refund.id);

    // Обновляем Payment status
    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentRecordId,
        fields: {
          [F.PAYMENT_STATUS]: 'refunded',
          [F.PAYMENT_NOTES]: `Возврат: ${refund.id}`,
        }
      }]
    });

    return { ok: true, refundId: refund.id };

  } catch (err) {
    console.error('[payment_refund] ERROR:', err);
    return { ok: false, error: err.message || 'Refund failed' };
  }
}

module.exports = { createRefund };
