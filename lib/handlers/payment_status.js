// lib/handlers/payment_status.js
// Получить статус платежа из ЮKassa и обновить в Airtable

const { json, atGet, atPatch, one, TABLE, F } = require('../utils');

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

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const paymentRecordId = url.searchParams.get('paymentId');

    if (!paymentRecordId) {
      return json(res, 400, { ok: false, error: 'paymentId required' });
    }

    // Получаем Payment из Airtable
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
      return json(res, 404, { ok: false, error: 'Payment not found' });
    }

    const externalId = payment.fields?.[F.PAYMENT_EXTERNAL_ID];
    const currentStatus = payment.fields?.[F.PAYMENT_STATUS];
    const amount = payment.fields?.[F.PAYMENT_AMOUNT] || 0;

    console.log('[payment_status] Payment found:', paymentRecordId, 'currentStatus:', currentStatus);

    // Проверяем статус в ЮKassa
    if (!externalId) {
      return json(res, 400, { ok: false, error: 'Payment has no external ID' });
    }

    const providerLink = payment.fields?.[F.PAYMENT_PROVIDER];
    const bankRecordId = Array.isArray(providerLink) ? providerLink[0] : providerLink;
    
    if (!bankRecordId) {
      return json(res, 400, { ok: false, error: 'Payment has no provider' });
    }

    const creds = await getBankCredentials(bankRecordId);
    if (!creds) {
      return json(res, 500, { ok: false, error: 'Failed to get bank credentials' });
    }

    // Запрашиваем статус из ЮKassa
    const authHeader = 'Basic ' + Buffer.from(`${creds.shopId}:${creds.secretKey}`).toString('base64');
    
    const yookassaResp = await fetch(`https://api.yookassa.ru/v3/payments/${externalId}`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!yookassaResp.ok) {
      return json(res, 500, { ok: false, error: 'Failed to fetch payment from YooKassa' });
    }

    const yookassaPayment = await yookassaResp.json();
    const newStatus = yookassaPayment.status;
    const paid = yookassaPayment.paid;

    console.log('[payment_status] YooKassa response:', newStatus, 'paid:', paid);

    // Обновляем статус в Airtable если изменился
    if (newStatus !== currentStatus) {
      console.log('[payment_status] Status changed from', currentStatus, 'to', newStatus);
      
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
          fields: updateFields
        }]
      });
    }

    // Обновляем Order и Order Lines для ЛЮБОГО succeeded платежа (не только при изменении статуса)
    if (newStatus === 'succeeded' && paid) {
      console.log('[payment_status] Payment succeeded, updating Order Lines...');
      
      const orderLinks = payment.fields?.[F.PAYMENT_ORDERS];
      const orderIds = Array.isArray(orderLinks) ? orderLinks : (orderLinks ? [orderLinks] : []);
      
      if (orderIds.length > 0) {
        // Обновляем Order status
        const orderUpdateRecords = orderIds.map(orderId => ({
          id: orderId,
          fields: {
            [F.ORDER_STATUS]: 'Confirmed',
          }
        }));

        await atPatch(TABLE.ORDERS, {
          typecast: true,
          records: orderUpdateRecords
        });

        console.log('[payment_status] Updated Order status to Confirmed');

        // Обновляем Line Type с 'Pending' на 'Paid' для всех платных Order Lines
        for (const orderId of orderIds) {
            try {
              console.log(`[payment_status] Processing order ${orderId} for Line Type update`);
              
              // Получаем Order record чтобы получить список Order Lines
              const orderResp = await atGet(TABLE.ORDERS, {
                filterByFormula: `RECORD_ID()='${orderId}'`,
                'fields[]': [F.ORDER_OL_LINK],
                maxRecords: 1
              });

              const order = one(orderResp.records);
              const lineLinks = order?.fields?.[F.ORDER_OL_LINK] || [];
              const lineIds = Array.isArray(lineLinks) ? lineLinks : [lineLinks];
              
              console.log(`[payment_status] Order has ${lineIds.length} Order Lines`);
              if (lineIds.length === 0) continue;

              // Получаем все Order Lines для этого заказа
              const or = `OR(${lineIds.map(id => `RECORD_ID()='${id}'`).join(',')})`;
              const linesResp = await atGet(TABLE.ORDERLINES, {
                filterByFormula: or,
                'fields[]': [F.OL_TYPE],
                maxRecords: 100
              });

              console.log(`[payment_status] Fetched ${linesResp.records?.length || 0} Order Lines`);

              // Фильтруем только Pending линии
              const pendingLines = (linesResp.records || []).filter(
                line => String(line.fields?.[F.OL_TYPE] || '').toLowerCase() === 'pending'
              );

              console.log(`[payment_status] Found ${pendingLines.length} Pending lines to update`);

              if (pendingLines.length > 0) {
                const lineUpdates = pendingLines.map(line => ({
                  id: line.id,
                  fields: {
                    [F.OL_TYPE]: 'Paid',
                  }
                }));

                await atPatch(TABLE.ORDERLINES, {
                  typecast: true,
                  records: lineUpdates
                });

                console.log(`[payment_status] Successfully updated ${lineUpdates.length} Order Lines to Paid`);
              }
            } catch (e) {
              console.error('[payment_status] Failed to update Order Lines:', e);
            }
          }
        }
      }

    return json(res, 200, {
      ok: true,
      status: newStatus,
      paid: paid || false,
      amount
    });

  } catch (err) {
    console.error('[payment_status] ERROR:', err);
    return json(res, 500, { 
      ok: false,
      error: err.message || 'Status check failed'
    });
  }
};
