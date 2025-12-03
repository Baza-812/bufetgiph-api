const { F, TABLE, atGet, atPatch, atList } = require('../utils');

module.exports = async (req, res) => {
  console.log('📥 Payment webhook received');
  
  try {
    const body = req.body;
    
    // YooKassa webhook
    if (body.event === 'payment.succeeded') {
      const externalId = body.object.id;
      
      console.log(`✅ Payment succeeded: ${externalId}`);
      
      // Находим платёж в Airtable
      const payments = await atList(TABLE.PAYMENTS, {
        filterByFormula: `{${F.PAYMENT_EXTERNAL_ID}} = '${externalId}'`,
      });
      
      if (!payments.records.length) {
        console.error(`❌ Payment not found: ${externalId}`);
        return res.status(404).json({ error: 'Payment not found' });
      }
      
      const paymentRec = payments.records[0];
      const orderIds = paymentRec.fields[F.PAYMENT_ORDERS] || [];
      
      // Обновляем статус платежа
      await atPatch(TABLE.PAYMENTS, {
        typecast: true,
        records: [{
          id: paymentRec.id,
          fields: {
            [F.PAYMENT_STATUS]: 'succeeded',
            [F.PAYMENT_PAID_AT]: new Date().toISOString(),
          }
        }]
      });
      
      // Обновляем все связанные заказы
      if (orderIds.length) {
        await atPatch(TABLE.ORDERS, {
          typecast: true,
          records: orderIds.map(orderId => ({
            id: orderId,
            fields: {
              [F.ORDER_STATUS]: 'paid',
            }
          }))
        });
        
        console.log(`✅ ${orderIds.length} order(s) marked as paid`);
      }
      
      return res.status(200).json({ ok: true });
    }
    
    // Другие события
    console.log('ℹ️ Unhandled webhook event:', body.event);
    return res.status(200).json({ ok: true });
    
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
