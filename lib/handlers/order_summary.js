// /api/order_summary.js
const { json, atGet, TABLE } = require('../lib/utils');

/**
 * Поддержка:
 *  1) GET /api/order_summary?orderId=recXXXX
 *  2) GET /api/order_summary?org=org001&employeeID=recEmp...&date=YYYY-MM-DD
 *
 * Возврат:
 *  { ok:true, summary: { orderId, date, status } | null }
 */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  try {
    const q = req.query || {};
    const orderId = q.orderId;

    // ---- Режим 1: по orderId
    if (orderId) {
      const r = await atGet(TABLE.ORDERS, {
        filterByFormula: `RECORD_ID()='${orderId}'`,
        maxRecords: 1,
        "fields[]": ['Order Date', 'Status'],
      });
      const rec = r.records?.[0];
      if (!rec) return json(res, 404, { error: 'order not found' });
      const f = rec.fields || {};
      return json(res, 200, {
        ok: true,
        summary: {
          orderId: rec.id,
          date: f['Order Date'] || '',
          status: f['Status'] || '',
        },
      });
    }

    // ---- Режим 2: по org + employeeID + date
    const org = q.org;
    const employeeID = q.employeeID;
    const date = q.date;

    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    // Важно:
    //  - 'Order Date' — текстовая дата 'YYYY-MM-DD'
    //  - 'Employee'   — линк на Employees (массив recordId)
    //
    // Сопоставляем по наличию recordId сотрудника в линке и точному совпадению даты.
    const formula = `AND(
      {Order Date}='${date}',
      FIND('${employeeID}', ARRAYJOIN({Employee}))
    )`;

    const orders = await atGet(TABLE.ORDERS, {
      filterByFormula: formula,
      maxRecords: 1,
      "fields[]": ['Order Date', 'Status'],
    });

    const found = orders.records?.[0];
    if (!found) return json(res, 200, { ok: true, summary: null });

    const sf = found.fields || {};
    return json(res, 200, {
      ok: true,
      summary: {
        orderId: found.id,
        date: sf['Order Date'] || date,
        status: sf['Status'] || '',
      },
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
