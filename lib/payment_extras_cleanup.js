// Удаление неоплаченных строк заказа (Line Type = Pending), привязанных к отменённому платежу за допы.
// Статус заказа (New / Confirmed) не меняется — основной обед остаётся в выгрузке на производство и доставку.

const { atGet, atPatch, atDelete, one, TABLE, F } = require('./utils');

function paymentIdsFromOrderField(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return raw ? [raw] : [];
}

async function orderHasOtherOpenPayment(orderId, excludePaymentId) {
  const orderResp = await atGet(TABLE.ORDERS, {
    filterByFormula: `RECORD_ID()='${orderId}'`,
    'fields[]': [F.ORDER_PAYMENT],
    maxRecords: 1,
  });
  const order = one(orderResp.records);
  if (!order) return false;
  const pids = paymentIdsFromOrderField(order.fields?.[F.ORDER_PAYMENT]);
  for (const pid of pids) {
    if (pid === excludePaymentId) continue;
    const pr = await atGet(TABLE.PAYMENTS, {
      filterByFormula: `RECORD_ID()='${pid}'`,
      'fields[]': [F.PAYMENT_STATUS, F.PAYMENT_LINK],
      maxRecords: 1,
    });
    const p = one(pr.records);
    if (!p) continue;
    const st = String(p.fields?.[F.PAYMENT_STATUS] || '').toLowerCase();
    const link = p.fields?.[F.PAYMENT_LINK];
    if ((st === 'pending' || st === 'waiting_for_capture') && link) return true;
  }
  return false;
}

/**
 * После отмены платежа ЮKassa: удалить Pending Order Lines и отвязать этот Payment от заказа.
 * Если на заказе уже есть другой незавершённый платёж с ссылкой — строки не трогаем.
 */
async function cleanupAfterCanceledExtrasPayment(airtablePaymentRecordId) {
  const payResp = await atGet(TABLE.PAYMENTS, {
    filterByFormula: `RECORD_ID()='${airtablePaymentRecordId}'`,
    'fields[]': [F.PAYMENT_ORDERS, F.PAYMENT_STATUS],
    maxRecords: 1,
  });
  const payRec = one(payResp.records);
  if (!payRec) return { ok: false, orderIds: [], deletedLineIds: [], skipped: 'payment_not_found' };

  const st = String(payRec.fields?.[F.PAYMENT_STATUS] || '').toLowerCase();
  if (st !== 'canceled' && st !== 'cancelled') {
    return { ok: true, orderIds: [], deletedLineIds: [], skipped: 'not_canceled' };
  }

  const orderLinks = payRec.fields?.[F.PAYMENT_ORDERS];
  const orderIds = Array.isArray(orderLinks) ? orderLinks.filter(Boolean) : orderLinks ? [orderLinks] : [];

  const allDeleted = [];
  for (const orderId of orderIds) {
    if (await orderHasOtherOpenPayment(orderId, airtablePaymentRecordId)) {
      continue;
    }

    const orderResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      'fields[]': [F.ORDER_OL_LINK, F.ORDER_PAYMENT],
      maxRecords: 1,
    });
    const order = one(orderResp.records);
    if (!order) continue;

    const lineLinks = order.fields?.[F.ORDER_OL_LINK] || [];
    const lineIds = Array.isArray(lineLinks) ? lineLinks.filter(Boolean) : lineLinks ? [lineLinks] : [];

    let pendingLineIds = [];
    if (lineIds.length) {
      const or = `OR(${lineIds.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
      const linesResp = await atGet(TABLE.ORDERLINES, {
        filterByFormula: or,
        'fields[]': [F.OL_TYPE],
        maxRecords: 100,
      });
      pendingLineIds = (linesResp.records || [])
        .filter((line) => String(line.fields?.[F.OL_TYPE] || '').toLowerCase() === 'pending')
        .map((line) => line.id);
    }

    if (pendingLineIds.length) {
      await atDelete(TABLE.ORDERLINES, pendingLineIds);
      allDeleted.push(...pendingLineIds);
    }

    const oldPay = paymentIdsFromOrderField(order.fields?.[F.ORDER_PAYMENT]);
    if (!oldPay.includes(airtablePaymentRecordId)) continue;

    const payField = oldPay.filter((id) => id !== airtablePaymentRecordId);
    await atPatch(TABLE.ORDERS, {
      typecast: true,
      records: [{ id: orderId, fields: { [F.ORDER_PAYMENT]: payField } }],
    });
  }

  return { ok: true, orderIds, deletedLineIds: allDeleted };
}

module.exports = {
  cleanupAfterCanceledExtrasPayment,
};
