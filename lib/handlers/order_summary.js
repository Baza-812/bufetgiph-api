// /lib/handlers/order_summary.js
const { json, atGet, TABLE, F } = require('../utils');

// Утилита: маленькая "where" формула
function andFormula(parts) {
  return parts.filter(Boolean).length > 1
    ? `AND(${parts.filter(Boolean).join(',')})`
    : (parts.filter(Boolean)[0] || '');
}

// Вспомогательная: вытягиваем 1 заказ по фильтру
async function fetchOneOrder(filter, fields = []) {
  const r = await atGet(TABLE.ORDERS, {
    filterByFormula: filter,
    maxRecords: 1,
    'fields[]': [
      F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_EMPLOYEE,
      // удобные для вывода поля — подставь свои формулы/луккапы
      'Employee Full Name',
      'Meal Box Summary',
      'Extra 1 Name',
      'Extra 2 Name',
      ...fields,
    ],
  });
  return r.records?.[0] || null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, employeeID, date, scope } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // фильтр по дате (важно: именно "Order Date", если так названо у тебя)
    const byDate = `{${F.ORDER_DATE}}='${date}'`;

    // не считаем отменённые
    const notCancelled = `NOT(OR(LOWER(${F.ORDER_STATUS})='cancelled', LOWER(${F.ORDER_STATUS})='canceled'))`;

    let rec = null;

    if (String(scope || '').toLowerCase() === 'org') {
      // режим по организации: любой менеджерский заказ данной орг/даты
      // Привязка к орг: через луккап Employee -> Org (часто это F.EMP_ORG_LOOKUP на самой записи Employees,
      // а на Orders есть ссылка на Employee). Самый простой путь — в Orders хранить "OrgID" (если есть).
      // Если у тебя есть поле OrgID на заказе — используй его. Если нет — пойдём через社員:
      // формула: дата И (есть Employee) И статус НЕ Cancelled.
      // Дополнительно можно добавить фильтр по "Order Type"='Manager', если ведёшь тип.
      rec = await fetchOneOrder(
        andFormula([
          byDate,
          notCancelled,
          // если есть поле типа 'Order Type' — раскомментируй:
          // `LOWER({Order Type})='manager'`,
        ])
      );

      // Если нашёлся, возвращаем
    } else {
      // обычный (персональный) режим: дата + этот employeeID
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });

      rec = await fetchOneOrder(
        andFormula([
          byDate,
          notCancelled,
          // строго по связке на сотрудника
          `{${F.ORDER_EMPLOYEE}} = '${employeeID}'`,
        ])
      );
    }

    if (!rec) return json(res, 200, { ok: true, summary: null });

    const f = rec.fields || {};
    const summary = {
      orderId: rec.id,
      date: f[F.ORDER_DATE] || '',
      status: f[F.ORDER_STATUS] || '',
      // простенький список строк для модалки
      lines: [
        f['Meal Box Summary'] || null,
        f['Extra 1 Name'] || null,
        f['Extra 2 Name'] || null,
      ].filter(Boolean),
    };

    return json(res, 200, { ok: true, summary });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
