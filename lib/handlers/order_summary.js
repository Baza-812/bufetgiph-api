// /lib/handlers/order_summary.js
// Поиск заказа по дате/организации (менеджерский скоуп) + аккуратный состав для модалки.
// Опираемся на поля Orders: OrderDateISO (или "Order Date ISO") и линк-поле Org (-> Organizations).
// Красивые строки состава: "Main Name + Side Name × qty" и "Item Name × qty" (имена из Menu).

const { json, atGet, TABLE, F } = require('../utils');

const lower = (v) => String(v || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled';
};

// ---- Поля/таблицы (с бэкапами на F.* если заданы в utils) ----
const FLD_STATUS          = F.ORDER_STATUS   || 'Status';
const FLD_EMP_LINK        = F.ORDER_EMPLOYEE || 'Employee';
const FLD_ORDER_ORG_LINK  = 'Org';                       // линк на Organizations (по структуре)
const DATE_FIELDS_TRY     = ['OrderDateISO', 'Order Date ISO']; // кандидаты поля даты в Orders

const FLD_ORDER_MB_LINK   = F.ORDER_MB_LINK  || 'Meal Boxes';
const FLD_ORDER_OL_LINK   = F.ORDER_OL_LINK  || 'Order Lines';
const TBL_MEALBOXES       = TABLE.MEALBOXES  || 'Meal Boxes';
const TBL_ORDERLINES      = TABLE.ORDERLINES || 'Order Lines';
const TBL_MENU            = TABLE.MENU       || 'Menu';

const FLD_MB_QTY          = F.MB_QTY   || 'Quantity';
const FLD_MB_MAIN         = F.MB_MAIN  || 'Main (Menu Item)';
const FLD_MB_SIDE         = F.MB_SIDE  || 'Side (Menu Item)';

const FLD_OL_QTY          = F.OL_QTY   || 'Quantity';
const FLD_OL_ITEM         = F.OL_ITEM  || 'Item (Menu Item)';

const FLD_MENU_NAME       = 'Name';                      // у Menu обычно поле Name

// ---- Утилиты ----
function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

// Находим запись Organizations по коду org и возвращаем её recordId
async function getOrgRecordIdByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    maxRecords: 1,
    filterByFormula: eqStr(F.ORG_ID || 'OrgID', orgCode),
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

// Забираем заказы на дату в Orders по конкретному полю даты
async function fetchOrdersByDateField(dateField, isoDate) {
  const r = await atGet(TABLE.ORDERS, {
    filterByFormula: eqStr(dateField, isoDate),
    pageSize: 100,
  });
  return r.records || [];
}

// Чтение записей по списку recordId (чиним лимит на длину формулы — чанкаем по 40)
async function fetchByIdsChunked(table, ids) {
  if (!ids || !ids.length) return [];
  const out = [];
  const chunkSize = 40;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const r = await atGet(table, { filterByFormula: or, pageSize: 100 });
    out.push(...(r.records || []));
  }
  return out;
}

// Собираем красивые строки состава заказа
async function buildLinesForOrder(orderId) {
  // 1) прочитаем заказ, чтобы взять линки
  const rOrd = await atGet(TABLE.ORDERS, {
    maxRecords: 1,
    filterByFormula: `RECORD_ID()='${orderId}'`,
  });
  const rec = (rOrd.records || [])[0];
  if (!rec) return [];

  const f = rec.fields || {};
  const mbIds = Array.isArray(f[FLD_ORDER_MB_LINK]) ? f[FLD_ORDER_MB_LINK] : [];
  const olIds = Array.isArray(f[FLD_ORDER_OL_LINK]) ? f[FLD_ORDER_OL_LINK] : [];

  // 2) грузим Meal Boxes и Order Lines
  const [mbRecs, olRecs] = await Promise.all([
    fetchByIdsChunked(TBL_MEALBOXES, mbIds),
    fetchByIdsChunked(TBL_ORDERLINES, olIds),
  ]);

  // 3) соберём все id блюд (main/side/item), чтобы одним махом получить имена из Menu
  const menuIds = new Set();
  for (const mb of mbRecs) {
    const mf = mb.fields || {};
    const mainId = Array.isArray(mf[FLD_MB_MAIN]) ? mf[FLD_MB_MAIN][0] : mf[FLD_MB_MAIN];
    const sideId = Array.isArray(mf[FLD_MB_SIDE]) ? mf[FLD_MB_SIDE][0] : mf[FLD_MB_SIDE];
    if (mainId) menuIds.add(mainId);
    if (sideId) menuIds.add(sideId);
  }
  for (const ol of olRecs) {
    const of = ol.fields || {};
    const itemId = Array.isArray(of[FLD_OL_ITEM]) ? of[FLD_OL_ITEM][0] : of[FLD_OL_ITEM];
    if (itemId) menuIds.add(itemId);
  }

  // 4) подтягиваем имена
  const menuMap = {};
  if (menuIds.size) {
    const menuRecs = await fetchByIdsChunked(TBL_MENU, Array.from(menuIds));
    for (const m of menuRecs) {
      menuMap[m.id] = (m.fields && m.fields[FLD_MENU_NAME]) || '';
    }
  }

  // 5) формируем строки: "Main Name + Side Name × qty" / "Item Name × qty"
  const lines = [];

  for (const mb of mbRecs) {
    const mf = mb.fields || {};
    const qty = Number(mf[FLD_MB_QTY] || 0) || 0;
    if (qty <= 0) continue;

    const mainId = Array.isArray(mf[FLD_MB_MAIN]) ? mf[FLD_MB_MAIN][0] : mf[FLD_MB_MAIN];
    const sideId = Array.isArray(mf[FLD_MB_SIDE]) ? mf[FLD_MB_SIDE][0] : mf[FLD_MB_SIDE];

    const mainName = (mainId && menuMap[mainId]) || (mainId ? `Main:${mainId.slice(0,6)}…` : '');
    const sideName = (sideId && menuMap[sideId]) || (sideId ? `Side:${sideId.slice(0,6)}…` : '');

    const title = sideName
      ? `${mainName} + ${sideName}`
      : (mainName || 'Meal Box');

    lines.push(`${title} × ${qty}`);
  }

  for (const ol of olRecs) {
    const of = ol.fields || {};
    const qty = Number(of[FLD_OL_QTY] || 0) || 0;
    if (qty <= 0) continue;

    const itemId = Array.isArray(of[FLD_OL_ITEM]) ? of[FLD_OL_ITEM][0] : of[FLD_OL_ITEM];
    const itemName = (itemId && menuMap[itemId]) || (itemId ? `Item:${itemId.slice(0,6)}…` : 'Item');

    lines.push(`${itemName} × ${qty}`);
  }

  return lines;
}

// ---- Handler ----
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, employeeID, date, scope, with: withParam, debug } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // 1) узнаём запись организации
    const orgRecId = await getOrgRecordIdByCode(org);
    if (!orgRecId) {
      return json(res, 200, { ok: true, summary: null, ...(debug ? { diag: { reason: 'org_not_found', org } } : {}) });
    }

    // 2) пробуем разные поля даты на Orders
    let usedDateField = null;
    let onDate = [];
    for (const df of DATE_FIELDS_TRY) {
      const recs = await fetchOrdersByDateField(df, date);
      if (recs.length) { usedDateField = df; onDate = recs; break; }
    }
    if (!usedDateField) {
      return json(res, 200, {
        ok: true, summary: null,
        ...(debug ? { diag: { reason: 'no_orders_for_date', triedDateFields: DATE_FIELDS_TRY, date } } : {})
      });
    }

    // 3) общий предфильтр: не отменён
    const activeOnDate = onDate.filter((o) => !isCancelled(o.fields?.[FLD_STATUS]));

    // Помощник: проверка принадлежности заказов организации по линк-полю Org
    const belongsToOrg = (rec) => {
      const link = (rec.fields || {})[FLD_ORDER_ORG_LINK];
      if (Array.isArray(link)) return link.includes(orgRecId);
      return link === orgRecId;
    };

    let found = null;
    if (lower(scope) === 'org') {
      // Скоуп организации: любой активный заказ на дату, где Org == orgRecId
      found = activeOnDate.find(belongsToOrg) || null;
    } else {
      // Персональный: дата + employeeID + Org == orgRecId
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });
      found = activeOnDate.find((o) => {
        const empLink = Array.isArray(o.fields?.[FLD_EMP_LINK]) ? o.fields[FLD_EMP_LINK][0] : o.fields?.[FLD_EMP_LINK];
        return empLink === employeeID && belongsToOrg(o);
      }) || null;
    }

    if (!found) {
      return json(res, 200, {
        ok: true, summary: null,
        ...(debug ? { diag: { mode: (scope || 'employee'), usedDateField, onDate: onDate.length, activeOnDate: activeOnDate.length, orgRecId } } : {}),
      });
    }

    const summary = {
      orderId: found.id,
      date,
      status: (found.fields && found.fields[FLD_STATUS]) || '',
      lines: [],
    };

    // 4) Если просили состав — достанем красивые строки
    if (String(withParam || '') === 'lines') {
      try {
        summary.lines = await buildLinesForOrder(found.id);
      } catch {
        // не критично для работы — проглотим
      }
    }

    return json(res, 200, {
      ok: true,
      summary,
      ...(debug ? { diag: { mode: (scope || 'employee'), usedDateField, matched: found.id, onDate: onDate.length } } : {}),
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
