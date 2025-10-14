// /lib/handlers/order_summary.js
// Надёжный поиск заказа менеджера по дате/организации без сложных формул

const { json, atGet, TABLE, F } = require('../utils');

const PAGE_SIZE = 100; // максимум у Airtable

function lower(v) { return String(v || '').toLowerCase(); }
function isCancelled(status) {
  const s = lower(status);
  return s === 'cancelled' || s === 'canceled';
}

// Забираем заказы на дату одним запросом
async function fetchOrdersByDate(date) {
  const r = await atGet(TABLE.ORDERS, {
    'pageSize': PAGE_SIZE,
    'filterByFormula': `{${F.ORDER_DATE}}='${date}'`,
    'fields[]': [
      F.ORDER_DATE,
      F.ORDER_STATUS,
      F.ORDER_EMPLOYEE,
      'Order Type',             // если нет поля — просто вернётся undefined
      'Meal Box Summary',       // удобные для модалки, если настроены
      'Extra 1 Name',
      'Extra 2 Name',
    ],
  });
  return r.records || [];
}

// Батчом получаем сотрудников и их OrgID, формируем map: employeeId -> orgCode
async function buildEmpOrgMap(empIds) {
  if (!empIds.length) return {};
  // Соберём OR(RECORD_ID()='id1', RECORD_ID()='id2', ...)
  const or = `OR(${empIds.map(id => `RECORD_ID()='${id}'`).join(',')})`;
  const r = await atGet(TABLE.EMPLOYEES, {
    'pageSize': PAGE_SIZE,
    'filterByFormula': or,
    'fields[]': [F.EMP_ORG_LOOKUP],
  });
  const map = {};
  for (const rec of (r.records || [])) {
    const f = rec.fields || {};
    // Луккап может быть массивом; берём строковый OrgID
    const orgFromLookup = Array.isArray(f[F.EMP_ORG_LOOKUP]) ? f[F.EMP_ORG_LOOKUP][0] : f[F.EMP_ORG_LOOKUP];
    map[rec.id] = orgFromLookup || null;
  }
  return map;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, employeeID, date, scope, debug } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // 1) тянем все заказы на дату
    const orders = await fetchOrdersByDate(date);

    // 2) персональный режим (дата + employeeID + не Cancelled)
    if (lower(scope) !== 'org') {
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });
      const mine = orders.find(o => {
        const f = o.fields || {};
        const empLink = Array.isArray(f[F.ORDER_EMPLOYEE]) ? f[F.ORDER_EMPLOYEE][0] : f[F.ORDER_EMPLOYEE];
        return empLink === employeeID && !isCancelled(f[F.ORDER_STATUS]);
      });

      if (!mine) return json(res, 200, { ok: true, summary: null });

      const f = mine.fields || {};
      const summary = {
        orderId: mine.id,
        date: f[F.ORDER_DATE] || '',
        status: f[F.ORDER_STATUS] || '',
        lines: [
          f['Meal Box Summary'] || null,
          f['Extra 1 Name'] || null,
          f['Extra 2 Name'] || null,
        ].filter(Boolean),
      };

      return json(res, 200, { ok: true, summary, ...(debug ? { diag: { mode: 'employee', ordersCount: orders.length } } : {}) });
    }

    // 3) режим по организации
    //    a) соберём employeeId из найденных заказов,
    //    b) подтянем их OrgID,
    //    c) отфильтруем: org совпадает, статус не Cancelled, тип == Manager (если поле есть)
    const empIds = [];
    for (const o of orders) {
      const empLink = Array.isArray(o.fields?.[F.ORDER_EMPLOYEE]) ? o.fields[F.ORDER_EMPLOYEE][0] : o.fields?.[F.ORDER_EMPLOYEE];
      if (empLink) empIds.push(empLink);
    }
    const empOrgMap = await buildEmpOrgMap([...new Set(empIds)]);

    const suitable = orders.filter(o => {
      const f = o.fields || {};
      const empLink = Array.isArray(f[F.ORDER_EMPLOYEE]) ? f[F.ORDER_EMPLOYEE][0] : f[F.ORDER_EMPLOYEE];
      const empOrg  = empOrgMap[empLink] || null;
      const type    = lower(f['Order Type']);
      if (isCancelled(f[F.ORDER_STATUS])) return false;
      if (empOrg !== org) return false;
      // если в базе это поле ведётся — требуем Manager
      if (type && type !== 'manager') return false;
      return true;
    });

    const first = suitable[0] || null;
    if (!first) {
      return json(res, 200, {
        ok: true, summary: null,
        ...(debug ? { diag: { mode: 'org', ordersCount: orders.length, suitableCount: 0, empOrgMap } } : {}),
      });
    }

    const f = first.fields || {};
    const summary = {
      orderId: first.id,
      date: f[F.ORDER_DATE] || '',
      status: f[F.ORDER_STATUS] || '',
      lines: [
        f['Meal Box Summary'] || null,
        f['Extra 1 Name'] || null,
        f['Extra 2 Name'] || null,
      ].filter(Boolean),
    };

    return json(res, 200, {
      ok: true,
      summary,
      ...(debug ? {
        diag: {
          mode: 'org',
          ordersCount: orders.length,
          suitableCount: suitable.length,
          matchedOrderId: first.id,
          empOrgMap,
        },
      } : {}),
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
