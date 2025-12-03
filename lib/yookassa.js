// lib/yookassa.js
const { env } = require('./utils');

const YOOKASSA_SHOP_ID = env('YOOKASSA_SHOP_ID');
const YOOKASSA_SECRET_KEY = env('YOOKASSA_SECRET_KEY');
const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';

// Базовая авторизация для YooKassa
function getYooKassaHeaders() {
  const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
  return {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'Idempotence-Key': `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  };
}

// Создание платежа
async function createPayment({ amount, orderId, description, returnUrl }) {
  const response = await fetch(`${YOOKASSA_API_URL}/payments`, {
    method: 'POST',
    headers: getYooKassaHeaders(),
    body: JSON.stringify({
      amount: {
        value: amount.toFixed(2),
        currency: 'RUB'
      },
      confirmation: {
        type: 'redirect',
        return_url: returnUrl
      },
      capture: true,
      description: description || `Заказ ${orderId}`,
      metadata: {
        order_id: orderId
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`YooKassa error: ${response.status} ${error}`);
  }

  return response.json();
}

// Получение информации о платеже
async function getPayment(paymentId) {
  const response = await fetch(`${YOOKASSA_API_URL}/payments/${paymentId}`, {
    method: 'GET',
    headers: getYooKassaHeaders()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`YooKassa error: ${response.status} ${error}`);
  }

  return response.json();
}

module.exports = {
  createPayment,
  getPayment,
  YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY
};
