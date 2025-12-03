// lib/handlers/payment_create.js
const { json, withRateLimit, atGet, atPatch, one, TABLE, F } = require('../utils');
const { createPayment } = require('../yookassa');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  try {
    const body = JSON.parse(req.body || '{}');
    const { orderId, org, employeeID, token } = body;

    if (!orderId || !org || !employeeID || !token) {
      return json(res, 400, { ok: false, error: 'orderId, org, employeeID, token required' });
    }

    // Проверяем токен сотрудника
    const empResult = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `AND(RECORD_ID()='${employeeID}', {${F.EMP_TOKEN}}='${token}')`,
      maxRecords: 1
    });
    const empRec = one(empResult.records);
    if (!empRec) return json(res, 403, { ok: false, error: 'invalid token' });

    // Получаем заказ
    const orderResult = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      maxRecords: 1
    });
    const orderRec = one(orderResult.records);
    if (!orderRec) return json(res, 404, { ok: false, error: 'order not found' });

    // Проверяем что заказ принадлежит этому сотруднику
    const orderEmpId = orderRec.fields[F.ORDER_EMPLOYEE]?.[0];
    if (orderEmpId !== employeeID) {
      return json(res, 403, { ok: false, error: 'order does not belong to this employee' });
    }

    // Получаем цену из организации
    const orgResult = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      maxRecords: 1
    });
    const orgRec = one(orgResult.records);
    if (!orgRec) return json(res, 404, { ok: false, error: 'org not found' });

    const tariffCode = orderRec.fields[F.ORDER_TARIFF];
    const priceFull = orgRec.fields[F.ORG_PRICE_FULL] || 0;
    const priceLight = orgRec.fields[F.ORG_PRICE_LIGHT] || 0;
    
    const amount = tariffCode === 'full' ? priceFull : tariffCode === 'light' ? priceLight : 0;
    
    if (amount <= 0) {
      return json(res, 400, { ok: false, error: 'invalid amount' });
    }

    // Создаем платеж в YooKassa
    const orderDate = orderRec.fields[F.ORDER_DATE];
    const returnUrl = `${req.headers.origin || 'https://dev-orders.baza.menu'}/order?org=${org}&employeeID=${employeeID}&token=${token}`;
    
    const payment = await createPayment({
      amount,
      orderId,
      description: `Обед на ${orderDate}`,
      returnUrl
    });

    console.log('✅ Payment created:', payment);

    // Сохраняем paymentLink и paymentId в заказ
    await atPatch(TABLE.ORDERS, {
      records: [{
        id: orderId,
        fields: {
          [F.ORDER_PAY_LINK]: payment.confirmation.confirmation_url,
          PaymentId: payment.id,
          [F.ORDER_STATUS]: 'pending_payment'
        }
      }]
    });

    return json(res, 200, {
      ok: true,
      paymentUrl: payment.confirmation.confirmation_url,
      paymentId: payment.id
    });

  } catch (error) {
    console.error('❌ payment_create error:', error);
    return json(res, 500, { ok: false, error: error.message });
  }
}, { windowMs: 5000, max: 10 });
