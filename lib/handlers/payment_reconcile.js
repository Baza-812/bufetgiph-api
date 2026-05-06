// GET /api/payment_reconcile?key=SECRET
// Синхронизирует «зависшие» pending-платежи с ЮKassa (если пользователь закрыл окно оплаты без возврата на сайт).
// Вызывать по cron (например каждые 5–10 мин) с секретом PAYMENT_RECONCILE_KEY в query или заголовке X-Reconcile-Key.

const { json, atGet, TABLE, F } = require('../utils');
const { syncPaymentByRecordId } = require('../yookassa_payment_sync');

const MAX_BATCH = 40;

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const secret = process.env.PAYMENT_RECONCILE_KEY || '';
    if (!secret) {
      return json(res, 503, { ok: false, error: 'PAYMENT_RECONCILE_KEY not configured' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const qKey = url.searchParams.get('key') || '';
    const hKey = req.headers['x-reconcile-key'] || '';
    if (qKey !== secret && hKey !== secret) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }

    const pendingFormula = `AND(
      {${F.PAYMENT_EXTERNAL_ID}}!='',
      OR(
        LOWER({${F.PAYMENT_STATUS}})='pending',
        LOWER({${F.PAYMENT_STATUS}})='waiting_for_capture'
      )
    )`;

    const listResp = await atGet(TABLE.PAYMENTS, {
      filterByFormula: pendingFormula,
      'fields[]': [F.PAYMENT_STATUS, F.PAYMENT_EXTERNAL_ID],
      pageSize: MAX_BATCH,
    });

    const records = listResp.records || [];
    const results = [];

    for (const rec of records) {
      const r = await syncPaymentByRecordId(rec.id);
      results.push({ id: rec.id, ok: r.ok, status: r.status, error: r.error });
    }

    return json(res, 200, {
      ok: true,
      processed: results.length,
      results,
    });
  } catch (err) {
    console.error('[payment_reconcile] ERROR:', err);
    return json(res, 500, { ok: false, error: err.message || 'reconcile failed' });
  }
};
