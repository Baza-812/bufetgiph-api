// Системная отмена заказа (cron): без токена сотрудника, как order_cancel + refund.
const { atGet, atPatch, one, TABLE, F } = require('./utils');
const { createRefund } = require('./handlers/payment_refund');

function orderDateYmd(orderFields) {
  const raw = orderFields?.[F.ORDER_DATE];
  if (!raw) return '';
  const s = typeof raw === 'string' ? raw : new Date(raw).toISOString();
  return s.slice(0, 10);
}

/**
 * Отмена заказа и возврат при успешной оплате (как order_cancel).
 * @returns {Promise<{ ok: boolean, orderId: string, error?: string, refund?: object }>}
 */
async function systemCancelOrderAndRefund(orderId) {
  try {
    const or = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${String(orderId).replace(/'/g, "\\'")}'`,
      'fields[]': [F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_EMPLOYEE, F.ORDER_PAYMENT, F.ORDER_MB_LINK, F.ORDER_OL_LINK],
      maxRecords: 1,
    });
    const ord = one(or.records);
    if (!ord) return { ok: false, orderId, error: 'order not found' };

    const st = String(ord.fields?.[F.ORDER_STATUS] || '').toLowerCase();
    if (st === 'cancelled' || st === 'canceled' || st === 'deleted') {
      return { ok: true, orderId, skipped: true };
    }

    const paymentLinks = ord.fields?.[F.ORDER_PAYMENT];
    const paymentId = Array.isArray(paymentLinks) ? paymentLinks[0] : paymentLinks;
    let refund = null;
    if (paymentId) {
      refund = await createRefund(paymentId);
      if (!refund.ok) {
        console.warn('[ambassador_system_cancel] refund issue:', orderId, refund.error);
      }
    }

    await atPatch(TABLE.ORDERS, {
      typecast: true,
      records: [
        {
          id: orderId,
          fields: {
            [F.ORDER_STATUS]: 'Cancelled',
            [F.ORDER_MB_LINK]: [],
            [F.ORDER_OL_LINK]: [],
          },
        },
      ],
    });

    return { ok: true, orderId, refund };
  } catch (e) {
    console.error('[ambassador_system_cancel]', orderId, e);
    return { ok: false, orderId, error: e?.message || String(e) };
  }
}

module.exports = { systemCancelOrderAndRefund, orderDateYmd };
