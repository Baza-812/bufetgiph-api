// lib/yookassa_payment_sync.js — запрос статуса в ЮKassa и синхронизация Airtable (общая логика для payment_status и payment_reconcile)

const { atGet, atPatch, one, TABLE, F } = require('./utils');

async function getBankCredentials(bankRecordId) {
  const bankResp = await atGet(TABLE.BANKS, {
    filterByFormula: `RECORD_ID()='${bankRecordId}'`,
    'fields[]': [
      F.BANK_MERCHANT_ID,
      F.BANK_API_KEY,
      F.BANK_ENV_PREFIX,
      F.BANK_CREDS_SOURCE,
    ],
    maxRecords: 1,
  });

  const bank = one(bankResp.records);
  if (!bank) return null;

  const source = bank.fields?.[F.BANK_CREDS_SOURCE];
  let shopId;
  let secretKey;

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

/**
 * Подтянуть статус из ЮKassa и обновить Payments / Orders / Order Lines.
 * @returns {{ ok: true, status: string, paid: boolean, amount: number } | { ok: false, error: string }}
 */
async function syncPaymentByRecordId(paymentRecordId) {
  const paymentResp = await atGet(TABLE.PAYMENTS, {
    filterByFormula: `RECORD_ID()='${paymentRecordId}'`,
    'fields[]': [
      F.PAYMENT_EXTERNAL_ID,
      F.PAYMENT_STATUS,
      F.PAYMENT_PROVIDER,
      F.PAYMENT_AMOUNT,
      F.PAYMENT_ORDERS,
    ],
    maxRecords: 1,
  });

  const payment = one(paymentResp.records);
  if (!payment) {
    return { ok: false, error: 'Payment not found' };
  }

  const externalId = payment.fields?.[F.PAYMENT_EXTERNAL_ID];
  const currentStatus = payment.fields?.[F.PAYMENT_STATUS];
  const amount = payment.fields?.[F.PAYMENT_AMOUNT] || 0;

  if (!externalId) {
    return { ok: false, error: 'Payment has no external ID' };
  }

  const providerLink = payment.fields?.[F.PAYMENT_PROVIDER];
  const bankRecordId = Array.isArray(providerLink) ? providerLink[0] : providerLink;

  if (!bankRecordId) {
    return { ok: false, error: 'Payment has no provider' };
  }

  const creds = await getBankCredentials(bankRecordId);
  if (!creds) {
    return { ok: false, error: 'Failed to get bank credentials' };
  }

  const authHeader = `Basic ${Buffer.from(`${creds.shopId}:${creds.secretKey}`).toString('base64')}`;

  const yookassaResp = await fetch(`https://api.yookassa.ru/v3/payments/${externalId}`, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  });

  if (!yookassaResp.ok) {
    return { ok: false, error: 'Failed to fetch payment from YooKassa' };
  }

  const yookassaPayment = await yookassaResp.json();
  const newStatus = yookassaPayment.status;
  const paid = yookassaPayment.paid;

  if (newStatus !== currentStatus) {
    const updateFields = {
      [F.PAYMENT_STATUS]: newStatus,
    };

    if (paid && yookassaPayment.captured_at) {
      updateFields[F.PAYMENT_PAID_AT] = yookassaPayment.captured_at;
    }

    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentRecordId,
        fields: updateFields,
      }],
    });
  }

  if (newStatus === 'succeeded' && paid) {
    const orderLinks = payment.fields?.[F.PAYMENT_ORDERS];
    const orderIds = Array.isArray(orderLinks) ? orderLinks : (orderLinks ? [orderLinks] : []);

    if (orderIds.length > 0) {
      const orderUpdateRecords = orderIds.map((orderId) => ({
        id: orderId,
        fields: {
          [F.ORDER_STATUS]: 'Confirmed',
        },
      }));

      await atPatch(TABLE.ORDERS, {
        typecast: true,
        records: orderUpdateRecords,
      });

      for (const orderId of orderIds) {
        try {
          const orderResp = await atGet(TABLE.ORDERS, {
            filterByFormula: `RECORD_ID()='${orderId}'`,
            'fields[]': [F.ORDER_OL_LINK],
            maxRecords: 1,
          });

          const order = one(orderResp.records);
          const lineLinks = order?.fields?.[F.ORDER_OL_LINK] || [];
          const lineIds = Array.isArray(lineLinks) ? lineLinks : [lineLinks];
          if (lineIds.length === 0) continue;

          const or = `OR(${lineIds.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
          const linesResp = await atGet(TABLE.ORDERLINES, {
            filterByFormula: or,
            'fields[]': [F.OL_TYPE],
            maxRecords: 100,
          });

          const pendingLines = (linesResp.records || []).filter(
            (line) => String(line.fields?.[F.OL_TYPE] || '').toLowerCase() === 'pending',
          );

          if (pendingLines.length > 0) {
            await atPatch(TABLE.ORDERLINES, {
              typecast: true,
              records: pendingLines.map((line) => ({
                id: line.id,
                fields: { [F.OL_TYPE]: 'Paid' },
              })),
            });
          }
        } catch (e) {
          console.error('[yookassa_payment_sync] Order lines update failed:', e);
        }
      }
    }
  }

  return {
    ok: true,
    status: newStatus,
    paid: paid || false,
    amount,
  };
}

module.exports = {
  getBankCredentials,
  syncPaymentByRecordId,
};
