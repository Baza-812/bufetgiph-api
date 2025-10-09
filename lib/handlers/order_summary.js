// api/order_summary.js
const { json, atGet, TABLE, F, one } = require('../lib/utils');

// Безопасный геттер
const s1 = (v) => Array.isArray(v) ? String(one(v) || '') : (v == null ? '' : String(v));

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    const { orderId } = req.query || {};
    if (!orderId) return json(res, 400, { error: 'orderId required' });

    // 1) сам заказ
    const ord = await atGet(TABLE.ORDERS, { filterByFormula: `RECORD_ID() = '${orderId}'`, maxRecords: 1 });
    const orec = ord.records?.[0];
    if (!orec) return json(res, 404, { error: 'order not found' });

    const f = orec.fields || {};
    const mealBoxIds = Array.isArray(f[F.ORDER_MB_LINK]) ? f[F.ORDER_MB_LINK] : [];
    const olIds      = Array.isArray(f[F.ORDER_OL_LINK]) ? f[F.ORDER_OL_LINK] : [];

    // 2) meal boxes
    let mainName = '', sideName = '';
    if (mealBoxIds.length) {
      const mb = await atGet(TABLE.MEALBOXES, {
        filterByFormula: `OR(${mealBoxIds.map(id => `RECORD_ID()='${id}'`).join(',')})`,
        "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME]
      });
      const first = mb.records?.[0]?.fields || {};
      mainName = s1(first[F.MB_MAIN_NAME]) || '';
      sideName = s1(first[F.MB_SIDE_NAME]) || '';
    }

    // 3) order lines (возьмём до двух)
    let extras = [];
    if (olIds.length) {
      const ol = await atGet(TABLE.ORDERLINES, {
        filterByFormula: `OR(${olIds.map(id => `RECORD_ID()='${id}'`).join(',')})`,
        "fields[]": [F.OL_NAME, F.OL_TYPE]
      });
      for (const r of ol.records || []) {
        const lf = r.fields || {};
        const name = s1(lf[F.OL_NAME]);
        if (name) extras.push(name);
      }
      extras = extras.slice(0, 2);
    }

    // 4) итоговая сводка
    const summary = {
      fullName: s1(f[F.EMP_NAME]) || '',          // если есть lookup ФИО в заказе; если нет — оставим пусто
      date: s1(f[F.ORDER_DATE]) || '',
      mealBox: [mainName, sideName].filter(Boolean).join(' + ') || '',
      extra1: extras[0] || '',
      extra2: extras[1] || '',
      orderId
    };

    return json(res, 200, { ok: true, summary });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
