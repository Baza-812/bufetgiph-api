// /api/busy.js
const { json, atGet, F } = require('../lib/utils'); // пути подстрой под свой проект

function employeeFormula(employeeID) {
  const byLink = `SEARCH('${employeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}})) > 0`;
  const fld = (F.ORDER_EMPLOYEEID || '').trim(); // если настроили в .env (напр. EmployeeID)
  if (fld) {
    const byText = `{${fld}}='${employeeID}'`;
    return `OR(${byLink}, ${byText})`;
  }
  return byLink;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { employeeID='', org='', token='', dates='' } = req.query || {};
    if (!employeeID || !org || !token || !dates) {
      return json(res, 400, { error: 'employeeID, org, token, dates required' });
    }

    const list = String(dates).split(',').map(s=>s.trim()).filter(Boolean);
    const busy = {};
    const debug = [];

    for (const d of list) {
      // базовый фильтр по дате, сотруднику и НЕ Cancelled
      const emp = employeeFormula(employeeID);
      // если у вас есть столбец Order Type, можно добавить = 'Employee', если надо — раскомментируйте
      // const byType = `{${F.ORDER_TYPE}}='Employee'`;
      const filter = `AND(
        IS_SAME({${F.ORDER_DATE}}, '${d}', 'day'),
        ${emp},
        NOT({${F.ORDER_STATUS}}='Cancelled')
      )`;

      const r = await atGet('Orders', {
        filterByFormula: filter,
        maxRecords: 1,
        "fields[]": ['id'] // id и так вернётся, но fields[] не помешает
      });

      const rec = r.records?.[0];
      busy[d] = rec ? { exists: true, orderId: rec.id } : { exists: false };

      debug.push({ date: d, filterByFormula: filter, count: r.records?.length || 0, orderId: rec?.id });
    }

    return json(res, 200, { ok: true, busy, debug });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
