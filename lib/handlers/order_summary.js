// /lib/handlers/order_summary.js
// Универсальный summary-заказа для подсветки дат и модалки.
// Работает в двух режимах:
//  - scope=org  : дата + организация (Org линк), активный (не отменён). НЕ требует employeeID/token.
//  - (иначе)    : дата + organization + employeeID (если нужно).
// Дополнительно (with=lines) возвращает красивые строки состава.

const { json, atGet, TABLE, F } = require('../utils');

const lower = (v) => String(v || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled';
};

// ---- Константы полей/таблиц (подстраиваются под твои F.* если есть) ----
const ORDERS      = TABLE.ORDERS     || 'Orders';
const MEALBOXES   = TABLE.MEALBOXES  || 'Meal Boxes';
const ORDERLINES  = TABLE.ORDERLINES || 'Order Lines';
const ORGS        = TABLE.ORGS       || 'Organizations';

const FLD_STATUS        = F.ORDER_STATUS   || 'Status';
const FLD_EMP_LINK      = F.ORDER_EMPLOYEE || 'Employee';
const FLD_ORDER_ORG     = 'Org'; // линк на Organizations (по твоей структуре)
const DATE_FIELDS_TRY   = ['OrderDateISO', 'Order Date ISO']; // возможные имена поля ISO-даты в Orders

// Линки из Orders на строки состава
const FLD_ORDER_MB_LINK = F.ORDER_MB_LINK  || 'Meal Boxes';
const FLD_ORDER_OL_LINK = F.ORDER_OL_LINK  || 'Order Lines';

// Поля в Meal Boxes (готовые вычисляемые имена и количество)
const FLD_MB_QTY        = F.MB_QTY         || 'Quantity';
const FLD_MB_MAIN_NAME  = F.MB_MAIN_NAME   || 'Main Name';
const FLD_MB_SIDE_NAME  = F.MB_SIDE_NAME   || 'Side Name';

// Поля в Order Lines
const FLD_OL_QTY        = F.OL_QTY         || 'Quantity';
const FLD_OL_ITEM_NAME  = F.OL_ITEM_NAME   || 'Item Name';

// ---- Утилиты ----
function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

async function getOrgRecordIdByCode(orgCode) {
  const r = await atGet(ORGS, {
    maxRecords: 1,
    filterByFormula: eqStr(F.ORG_ID || 'OrgID', orgCode),
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

async function fetchOrdersByDateField(dateField, isoDate) {
  const r = await atGet(ORDERS, {
    filterByFormula: eqStr(dateField, isoDate),
    pageSize: 100,
  });
  return r.records || [];
}

async function fetchByIdsChunked(table, ids) {
  if (!ids || !ids.length) return [];
  const out = [];
  const chunk = 40;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const or = `OR(${part.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const r = await atGet(table, { filterByFormula: or, pageSize: 100 });
    out.push(...(r.records || []));
  }
  return out;
}

// Сборка красивых строк для модалки
async function buildLines(orderId) {
  // прочитаем заказ, чтобы взять линки
  const ord = await atGet(ORDERS, {
    maxRecords: 1,
    filterByFormula: `RECORD_ID()='${orderId}'`,
    "fields[]": [FLD_ORDER_MB_LINK, FLD_ORDER_OL_LINK],
  });
  const rec = (ord.records || [])[0];
  if (!rec) return [];

  const f = rec.fields || {};
  const mbIds = Array.isArray(f[FLD_ORDER_MB_LINK]) ? f[FLD_ORDER_MB_LINK] : [];
  const olIds = Array.isArray(f[FLD_ORDER_OL_LINK]) ? f[FLD_ORDER_OL_LINK] : [];

  const [mbRecs, olRecs] = await Promise.all([
    fetchByIdsChunked(MEALBOXES, mbIds),
    fetchByIdsChunked(ORDERLINES, olIds),
  ]);

  const lines = [];

  for (const mb of mbRecs) {
    const mf = mb.fields || {};
    const qty = Math.max(0, Number(mf[FLD_MB_QTY] || 0)) || 0;
    if (!qty) continue;
    const main = (mf[FLD_MB_MAIN_NAME] || '').toString();
    const side = (mf[FLD_MB_SIDE_NAME] || '').toString();
    const title = side ? `${main} + ${side}` : (main || 'Meal Box');
    lines.push(`${title} × ${qty}`);
  }

  for (const ol of olRecs) {
    const of = ol.fields || {};
    const qty = Math.max(0, Number(of[FLD_OL_QTY] || 0)) || 0;
    const name = (of[FLD_OL_ITEM_NAME] || '').toString();
    if (!name || !qty) continue;
    lines.push(`${name} × ${qty}`);
  }

  return lines;
}

// ---- Handler ----
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, date, scope, employeeID, with: withParam, debug } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // 1) ID записи Organizations по коду org
    const orgRecId = await getOrgRecordIdByCode(org);
    if (!orgRecId) return json(res, 200, { ok: true, summary: null, ...(debug ? { diag: { reason:'org_not_found' } } : {}) });

    // 2) заказы на эту дату (ищем по OrderDateISO или "Order Date ISO")
    let usedDateField = null;
    let onDate = [];
    for (const df of DATE_FIELDS_TRY) {
      const recs = await fetchOrdersByDateField(df, date);
      if (recs.length) { usedDateField = df; onDate = recs; break; }
    }
    if (!usedDateField) {
      return json(res, 200, { ok:true, summary:null, ...(debug ? { diag:{ reason:'no_orders_for_date', tried:DATE_FIELDS_TRY } } : {}) });
    }

    // 3) активные на дату
    const active = onDate.filter(o => !isCancelled(o.fields?.[FLD_STATUS]));

    // 4) оставляем только заказы этой организации
    const belongsToOrg = (rec) => {
      const link = (rec.fields || {})[FLD_ORDER_ORG];
      if (Array.isArray(link)) return link.includes(orgRecId);
      return link === orgRecId;
    };
    const ofOrg = active.filter(belongsToOrg);

    // 5) выбор заказа
    let found = null;
    if (lower(scope) === 'org') {
      // менеджерская страница — достаточно любого заказа этой организации
      found = ofOrg[0] || null;
    } else {
      // персональная ветка (если когда-нибудь нужен персональный вызов)
      if (!employeeID) {
        found = ofOrg[0] || null; // мягкий fallback
      } else {
        found = ofOrg.find(o => {
          const emp = Array.isArray(o.fields?.[FLD_EMP_LINK]) ? o.fields[FLD_EMP_LINK][0] : o.fields?.[FLD_EMP_LINK];
          return emp === employeeID;
        }) || null;
      }
    }

    if (!found) {
      return json(res, 200, {
        ok: true,
        summary: null,
        ...(debug ? { diag: { usedDateField, onDate: onDate.length, active: active.length, ofOrg: ofOrg.length } } : {})
      });
    }

    const status = found.fields?.[FLD_STATUS] || '';
    const orderId = found.id;

    // 6) при необходимости возвращаем состав
    let lines = [];
    if (String(withParam || '') === 'lines') {
      try { lines = await buildLines(orderId); } catch { /* не критично */ }
    }

    // возвращаем и lines, и items (на будущее)
    return json(res, 200, {
      ok: true,
      summary: { orderId, date, status, lines, items: lines },
      ...(debug ? { diag: { usedDateField, matched: orderId } } : {})
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
