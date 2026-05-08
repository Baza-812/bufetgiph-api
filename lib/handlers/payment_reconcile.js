// GET /api/payment_reconcile?key=SECRET
// Синхронизирует «зависшие» pending-платежи с ЮKassa (если пользователь закрыл окно оплаты без возврата на сайт).
// После перехода платежа в canceled удаляет неоплаченные Pending Order Lines и отвязку Payment от заказа
// (основной заказ остаётся New/Confirmed для выгрузки).
// Вызывать по cron (например каждые 5–10 мин) и/или за 30–60 мин до отчёта на производство.

const { json, atGet, TABLE, F, getPaymentReconcileSecret } = require('../utils');
const { syncPaymentByRecordId } = require('../yookassa_payment_sync');
const { cleanupAfterCanceledExtrasPayment } = require('../payment_extras_cleanup');

const MAX_BATCH = 40;
const CANCELED_CLEANUP_BATCH = 20;

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const secret = getPaymentReconcileSecret();
    if (!secret) {
      return json(res, 503, {
        ok: false,
        error: 'PAYMENT_RECONCILE_KEY not configured',
        hint:
          'В рантайме нет PAYMENT_RECONCILE_KEY ни RECONCILE_SECRET. Проверьте /api/health поле reconcile_key_configured и deployment (тот же проект Vercel, что и домен).',
        deployment: {
          vercel_env: process.env.VERCEL_ENV || null,
          vercel_url: process.env.VERCEL_URL || null,
          git_ref: process.env.VERCEL_GIT_COMMIT_REF || null,
        },
      });
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
      const row = { id: rec.id, ok: r.ok, status: r.status, error: r.error };
      if (r.ok && r.status) {
        const s = String(r.status).toLowerCase();
        if (s === 'canceled' || s === 'cancelled') {
          try {
            row.cleanup = await cleanupAfterCanceledExtrasPayment(rec.id);
          } catch (e) {
            row.cleanupError = e?.message || String(e);
          }
        }
      }
      results.push(row);
    }

    const canceledFormula = `OR(
      LOWER({${F.PAYMENT_STATUS}})='canceled',
      LOWER({${F.PAYMENT_STATUS}})='cancelled'
    )`;
    const canceledResp = await atGet(TABLE.PAYMENTS, {
      filterByFormula: canceledFormula,
      'fields[]': [F.PAYMENT_STATUS],
      pageSize: CANCELED_CLEANUP_BATCH,
    });
    const canceledCleanups = [];
    for (const rec of canceledResp.records || []) {
      try {
        canceledCleanups.push({
          id: rec.id,
          ...(await cleanupAfterCanceledExtrasPayment(rec.id)),
        });
      } catch (e) {
        canceledCleanups.push({ id: rec.id, ok: false, error: e?.message || String(e) });
      }
    }

    return json(res, 200, {
      ok: true,
      processed: results.length,
      results,
      canceledCleanupsAttempted: canceledCleanups.length,
      canceledCleanups,
    });
  } catch (err) {
    console.error('[payment_reconcile] ERROR:', err);
    return json(res, 500, { ok: false, error: err.message || 'reconcile failed' });
  }
};
