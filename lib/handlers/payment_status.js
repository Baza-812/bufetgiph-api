// lib/handlers/payment_status.js
// Получить статус платежа из ЮKassa и обновить в Airtable

const { json } = require('../utils');
const { syncPaymentByRecordId } = require('../yookassa_payment_sync');

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const paymentRecordId = url.searchParams.get('paymentId');

    if (!paymentRecordId) {
      return json(res, 400, { ok: false, error: 'paymentId required' });
    }

    const result = await syncPaymentByRecordId(paymentRecordId);
    if (!result.ok) {
      const code = result.error === 'Payment not found' ? 404 : 400;
      if (result.error === 'Failed to get bank credentials') {
        return json(res, 500, { ok: false, error: result.error });
      }
      if (result.error === 'Failed to fetch payment from YooKassa') {
        return json(res, 500, { ok: false, error: result.error });
      }
      return json(res, code, { ok: false, error: result.error });
    }

    return json(res, 200, {
      ok: true,
      status: result.status,
      paid: result.paid,
      amount: result.amount,
    });
  } catch (err) {
    console.error('[payment_status] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Status check failed',
    });
  }
};
