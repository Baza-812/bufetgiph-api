const { F, TABLE, atGet, atList, atCreate, atPatch } = require('../utils');
const { createPayment } = require('../payment-providers');

module.exports = async (req, res) => {
  const { org, employeeID, token } = req.query;
  
  if (!org || !employeeID || !token) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  
  try {
    // Проверяем токен
    const empRec = await atGet(TABLE.EMPLOYEES, employeeID);
    if (empRec.fields[F.EMP_TOKEN] !== token) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    // Находим все неоплаченные заказы
    const orders = await atList(TABLE.ORDERS, {
      filterByFormula: `AND(
        {${F.ORDER_EMPLOYEE}} = '${employeeID}',
        {${F.ORDER_STATUS}} = 'AwaitingPayment',
        {${F.ORDER_PAYMENT_METHOD}} = 'Online'
      )`,
    });
    
    if (!orders.records.length) {
      return res.status(400).json({ error: 'No unpaid orders' });
    }
    
    // Получаем организацию
    const orgRec = await atGet(TABLE.ORGANIZATIONS, org);
    const priceFull = orgRec.fields[F.ORG_PRICE_FULL] || 0;
    const priceLight = orgRec.fields[F.ORG_PRICE_LIGHT] || 0;
    
    // Считаем общую сумму
    let totalAmount = 0;
    const orderIds = [];
    
    for (const order of orders.records) {
      const tariff = order.fields[F.ORDER_TARIFF_CODE];
      const price = tariff === 'full' ? priceFull : tariff === 'light' ? priceLight : 0;
      totalAmount += price;
      orderIds.push(order.id);
    }
    
    if (totalAmount === 0) {
      return res.status(400).json({ error: 'Total amount is 0' });
    }
    
    // Создаём запись в Payments
    const paymentRec = await atCreate(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        fields: {
          [F.PAYMENT_ORGANIZATION]: [orgRec.id],
          [F.PAYMENT_EMPLOYEE]: [empRec.id],
          [F.PAYMENT_AMOUNT]: totalAmount,
          [F.PAYMENT_STATUS]: 'pending',
          [F.PAYMENT_METHOD]: 'Online',
          [F.PAYMENT_ORDERS]: orderIds,
          [F.PAYMENT_NOTES]: `Оплата ${orderIds.length} заказов`,
        }
      }]
    });
    
    const paymentRecordId = paymentRec.records[0].id;
    
    // Создаём платёж через провайдера
    const returnUrl = `${req.headers.origin || 'https://dev-orders.baza.menu'}/order?org=${org}&employeeID=${employeeID}&token=${token}`;
    
    const payment = await createPayment({
      orgRecordId: orgRec.id,
      amount: totalAmount,
      description: `Оплата ${orderIds.length} заказов`,
      returnUrl,
      metadata: {
        paymentRecordId,
        employeeID,
      },
    });
    
    // Обновляем запись в Payments
    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentRecordId,
        fields: {
          [F.PAYMENT_EXTERNAL_ID]: payment.externalId,
          [F.PAYMENT_LINK]: payment.paymentLink,
          [F.PAYMENT_PROVIDER]: [payment.bankRecordId],
        }
      }]
    });
    
    // Линкуем все заказы с платежом
    await atPatch(TABLE.ORDERS, {
      typecast: true,
      records: orderIds.map(orderId => ({
        id: orderId,
        fields: {
          Payment: [paymentRecordId],
        }
      }))
    });
    
    return res.status(200).json({
      ok: true,
      paymentLink: payment.paymentLink,
      amount: totalAmount,
      ordersCount: orderIds.length,
    });
    
  } catch (err) {
    console.error('❌ Pay all error:', err);
    return res.status(500).json({ error: err.message });
  }
};
