// lib/handlers/payment_webhook.js
// Обработка webhook уведомлений от ЮKassa о смене статуса платежа

const { json, atGet, atPatch, one, TABLE, F } = require('../utils');

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

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    const body = await readBody(req);
    
    // ЮKassa отправляет уведомление в формате:
    // { type: "notification", event: "payment.succeeded", object: { id, status, paid, ... } }
    const eventType = body.event;
    const payment = body.object;

    if (!payment || !payment.id) {
      return json(res, 400, { error: 'Invalid webhook payload' });
    }

    const externalId = payment.id;
    const status = payment.status; // 'pending', 'waiting_for_capture', 'succeeded', 'canceled'
    const paid = payment.paid;
    const paidAt = payment.captured_at || payment.created_at;

    // Находим Payment record по ExternalID
    const paymentResp = await atGet(TABLE.PAYMENTS, {
      filterByFormula: `{${F.PAYMENT_EXTERNAL_ID}}='${externalId}'`,
      'fields[]': [F.PAYMENT_STATUS, F.PAYMENT_ORDERS, F.PAYMENT_ORG],
      maxRecords: 1
    });

    const paymentRecord = one(paymentResp.records);
    if (!paymentRecord) {
      console.warn(`Payment not found for ExternalID: ${externalId}`);
      return json(res, 200, { ok: true, message: 'Payment record not found, but acknowledged' });
    }

    const currentStatus = paymentRecord.fields?.[F.PAYMENT_STATUS];
    
    // Не обновляем, если уже succeeded
    if (currentStatus === 'succeeded' && status !== 'succeeded') {
      return json(res, 200, { ok: true, message: 'Payment already succeeded, ignoring' });
    }

    // Обновляем Payment record
    const updateFields = {
      [F.PAYMENT_STATUS]: status,
    };

    if (paid && paidAt) {
      updateFields[F.PAYMENT_PAID_AT] = paidAt;
    }

    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentRecord.id,
        fields: updateFields
      }]
    });

    // Если платеж succeeded - обновляем статус Order
    if (status === 'succeeded' && paid) {
      const orderLinks = paymentRecord.fields?.[F.PAYMENT_ORDERS];
      const orderIds = Array.isArray(orderLinks) ? orderLinks : (orderLinks ? [orderLinks] : []);
      
      if (orderIds.length > 0) {
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
      }
    }

    return json(res, 200, { ok: true, status, paid });

  } catch (err) {
    console.error('payment_webhook error:', err);
    // Важно: всегда возвращаем 200, чтобы ЮKassa не ретраил webhook бесконечно
    return json(res, 200, { 
      ok: false, 
      error: err.message 
    });
  }
};
