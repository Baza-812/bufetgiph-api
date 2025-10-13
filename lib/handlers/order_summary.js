// /api/order_summary.js
const { json, atGet, TABLE, F } = require('../lib/utils');

/**
 * Поддерживаем два сценария:
 *  1) GET /api/order_summary?orderId=recXXXX
 *  2) GET /api/order_summary?org=org001&employeeID=recEmp...&date=YYYY-MM-DD[&mode=single]
 *
 * Возвращаем нормализованный объект:
 * { ok:true, summary:{ orderId, date, status, lines?: string[] } }
 *
 * Примечания:
 * - Статус НЕ фильтруем (кнопка дат должна сереть сразу после "New").
 * - Если хочешь фильтровать, включи allowedStatuses (см. ниже).
 */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  try {
    const q = req.query || {};
    const orderId = q.orderId;

    if (orderId) {
      // --- РЕЖИМ 1: по orderId
      const r = await atGet(TABLE.ORDERS, {
        filterByFormula: `RECORD_ID()='${orderId}'`,
        maxRecords: 1,
        "fields[]": [
          F.ORDER_DATE,
          F.ORDER_STATUS,
          // Если есть собственные lookup/summary-поля — добавь их сюда
          // Например:
          // 'Pretty Summary', 'Employee Full Name',
        ],
      });

      const rec = r.records?.[0];
      if (!rec) return json(res, 404, { error: 'order not found' });
      const f = rec.fields || {};

      const summary = {
        orderId: rec.id,
        date: f[F.ORDER_DATE] || '',
        status: f[F.ORDER_STATUS] || '',
        // lines: [], // при желании можешь собрать строки (см. ниже блок агрегации)
      };

      return json(res, 200, { ok: true, summary });
    }

    // --- РЕЖИМ 2: по org + employeeID + date
    const org = q.org;
    const employeeID = q.employeeID;
    const date = q.date;

    if (!org || !employeeID || !date) {
      return json(res, 400, { error: 'orderId OR (org + employeeID + date) required' });
    }

    // Если хочешь фильтровать по статусу, включи список:
    // const allowedStatuses = ['New','Submitted','Pending','Confirmed','Approved'];
    // и добавь условие в formula ниже (см. комментарий).

    // Поиск заказа на дату от конкретного сотрудника.
    // Сопоставляем связку по полю-линку "Employee" (F.ORDER_EMPLOYEE) с recordId сотрудника.
    // В Airtable удобнее сверять через ARRAYJOIN + FIND.
    const formulaParts = [
      `{${F.ORDER_DATE}}='${date}'`,
      `FIND('${employeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}))`,
      // Если нужно сверять org дополнительно через lookup в Order -> Organization, добавь сюда третье условие.
      // Пример (если у тебя есть F.ORDER_ORG_LINK):
      // `FIND('${org}', ARRAYJOIN({${F.ORDER_ORG_LINK}}))`,
      // Если хочешь фильтровать по статусу:
      // `FIND(',' & {${F.ORDER_STATUS}} & ',', ',' & 'New,Submitted,Pending,Confirmed,Approved' & ',')`
    ];
    const formula = `AND(${formulaParts.join(',')})`;

    const orders = await atGet(TABLE.ORDERS, {
      filterByFormula: formula,
      maxRecords: 1,
      "fields[]": [F.ORDER_DATE, F.ORDER_STATUS],
    });

    const found = orders.records?.[0];
    if (!found) return json(res, 200, { ok: true, summary: null });

    const sf = found.fields || {};
    const summary = {
      orderId: found.id,
      date: sf[F.ORDER_DATE] || date,
      status: sf[F.ORDER_STATUS] || '',
      // lines: [], // при желании — ниже есть пример агрегации
    };

    // ---------- (необязательно) Аггрегируем "lines" из Meal Boxes и Order Lines ----------
    // Если хочешь отображать состав в модалке:
    // - Сначала тянем Meal Boxes для заказа, затем, при необходимости, дотягиваем названия позиций из Menu.
    // - Аналогично для Order Lines (extras).
    //
    // Пример (раскомментируй, если готов тянуть меню):
    /*
    try {
      // 1) Meal Boxes
      const mb = await atGet(TABLE.MEALBOXES, {
        filterByFormula: `FIND('${found.id}', ARRAYJOIN({${F.MB_ORDER}}))`,
        "fields[]": [F.MB_MAIN, F.MB_SIDE, F.MB_QTY],
        maxRecords: 200,
      });

      // Соберём все menuIds
      const menuIds = new Set();
      (mb.records||[]).forEach(r => {
        const mf = r.fields || {};
        (mf[F.MB_MAIN]||[]).forEach(id => menuIds.add(id));
        (mf[F.MB_SIDE]||[]).forEach(id => menuIds.add(id));
      });

      // 2) Order Lines (extras)
      const ol = await atGet(TABLE.ORDERLINES, {
        filterByFormula: `FIND('${found.id}', ARRAYJOIN({${F.OL_ORDER}}))`,
        "fields[]": [F.OL_ITEM, F.OL_QTY],
        maxRecords: 200,
      });
      (ol.records||[]).forEach(r => {
        const lf = r.fields || {};
        (lf[F.OL_ITEM]||[]).forEach(id => menuIds.add(id));
      });

      // 3) Подтянем имена из Menu
      const namesMap = {};
      if (menuIds.size) {
        // Airtable не любит слишком длинные формулы; если записей много — разобьёшь на пачки
        const inList = Array.from(menuIds).map(id => `RECORD_ID()='${id}'`).join(',');
        const mp = await atGet(TABLE.MENU, {
          filterByFormula: `OR(${inList})`,
          "fields[]": ['Name'],
          maxRecords: 500,
        });
        (mp.records||[]).forEach(r => namesMap[r.id] = (r.fields||{}).Name || r.id);
      }

      const lines = [];

      (mb.records||[]).forEach(r => {
        const mf = r.fields || {};
        const qty = +mf[F.MB_QTY] || 0;
        const mainId = (mf[F.MB_MAIN]||[])[0];
        const sideId = (mf[F.MB_SIDE]||[])[0];
        const mainName = mainId ? (namesMap[mainId] || mainId) : '';
        const sideName = sideId ? (namesMap[sideId] || sideId) : '';
        if (qty > 0) {
          lines.push(`${mainName || '—'}${sideName ? ' + ' + sideName : ''} × ${qty}`);
        }
      });

      (ol.records||[]).forEach(r => {
        const lf = r.fields || {};
        const qty = +lf[F.OL_QTY] || 0;
        const itemId = (lf[F.OL_ITEM]||[])[0];
        const name = itemId ? (namesMap[itemId] || itemId) : '';
        if (qty > 0) {
          lines.push(`${name} × ${qty}`);
        }
      });

      if (lines.length) summary.lines = lines;
    } catch (e) {
      // Состав не критичен для "есть/нет", безопасно игнорируем
    }
    */
    // -----------------------------------------------------------------------------------

    return json(res, 200, { ok: true, summary });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
