// /api/order_summary.js
const { json, atGet, TABLE, F, getLinkId } = require('../lib/utils');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok:true });
  if (req.method !== 'GET')     return json(res, 405, { error:'GET only' });

  try {
    const { orderId } = req.query || {};
    if (!orderId) return json(res, 400, { error: 'orderId required' });

    const r = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID() = '${orderId}'`,
      maxRecords: 1,
      // Подтяните нужные луккапы/формулы для фио/состава бокса
      "fields[]": [
        F.ORDER_DATE, F.ORDER_STATUS,
        // ниже — ваши луккапы/формулы, которые уже используете в /api/hr_orders
        'Employee Full Name',    // пример — имя луккапа
        'Meal Box Summary',      // пример — описание бокса
        'Extra 1 Name',          // пример — экстра 1
        'Extra 2 Name',          // пример — экстра 2
      ],
    });

    const rec = r.records?.[0];
    if (!rec) return json(res, 404, { error: 'order not found' });

    const f = rec.fields || {};
    const summary = {
      fullName: f['Employee Full Name'] || '',
      date:     f[F.ORDER_DATE] || '',
      mealBox:  f['Meal Box Summary'] || '',
      extra1:   f['Extra 1 Name'] || '',
      extra2:   f['Extra 2 Name'] || '',
      orderId:  rec.id,
    };

    return json(res, 200, { ok:true, summary });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
