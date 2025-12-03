// lib/handlers/payment_webhook.js
const { json, atGet, atPatch, one, TABLE, F } = require('../utils');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  try {
    const body = JSON.parse(req.body || '{}');
    console.log('📥 YooKassa webhook:', JSON.stringify(body, null, 2));

    const { event, object } = body;

    if (event === 'payment.succeeded') {
      const paymentId = object.id;
      const orderId = object.metadata?.order_id;

      if (!orderId) {
        console.error('❌ No order_id in payment metadata');
        return json(res, 400, { ok: false, error: 'no order_id' });
      }

      // Обновляем статус заказа
      await atPatch(TABLE.ORDERS, {
        records: [{
          id: orderId,
          fields: {
            [F.ORDER_STATUS]: 'paid',
            PaymentId: paymentId
          }
        }]
      });

      console.log(`✅ Order ${orderId} marked as paid`);
      return json(res, 200, { ok: true });
    }

    if (event === 'payment.canceled') {
      const paymentId = object.id;
      const orderId = object.metadata?.order_id;

      if (orderId) {
        await atPatch(TABLE.ORDERS, {
          records: [{
            id: orderId,
            fields: {
              [F.ORDER_STATUS]: 'payment_failed',
              PaymentId: paymentId
            }
          }]
        });
        console.log(`❌ Order ${orderId} payment canceled`);
      }

      return json(res, 200, { ok: true });
    }

    // Другие события игнорируем
    return json(res, 200, { ok: true });

  } catch (error) {
    console.error('❌ payment_webhook error:', error);
    return json(res, 500, { ok: false, error: error.message });
  }
};
