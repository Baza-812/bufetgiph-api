// /lib/handlers/order_summary.js
// Поиск заказа по дате/организации: терпим к названиям полей (OrderDateISO vs "Order Date ISO"),
// минимальные формулы, остальное — фильтруем на сервере.

const { json, atGet, TABLE, F } = require('../utils');

const lower = (v) => String(v || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled';
};

const FLD_STATUS   = F.ORDER_STATUS   || 'Status';
const FLD_EMP_LINK = F.ORDER_EMPLOYEE || 'Employee';
// Линк на Organizations (по структуре у тебя именно "Org")
const FLD_ORDER_ORG_LINK = 'Org';

// кандидаты названий поля даты
const DATE_FIELDS_TRY = ['OrderDateISO', 'Order Date ISO'];

// экранирование строки для формулы
function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

// находим запись Organizations по коду org и берём её recordId
async function getOrgRecordIdByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    maxRecords: 1,
    filterByFormula: eqStr(F.ORG_ID || 'OrgID', orgCode),
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

// тянем заказы на дату по конкретному полю даты
async function fetchOrdersByDateField(dateField, isoDate) {
  const r = await atGet(TABLE.ORDERS, {
    filterByFormula: eqStr(dateField, isoDate),
    pageSize: 100,
  });
  return r.records || [];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, employeeID, date, scope, debug } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // узнаём запись организации
    const orgRecId = await getOrgRecordIdByCode(org);
    if (!orgRecId) {
      return json(res, 200, { ok: true, summary: null, ...(debug ? { diag: { reason: 'org_not_found', org } } : {}) });
    }

    // пробуем разные поля даты, пока не найдём записи
    let usedDateField = null;
    let onDate = [];
    for (const df of DATE_FIELDS_TRY) {
      const recs = await fetchOrdersByDateField(df, date);
      if (recs.length) { usedDateField = df; onDate = recs; break; }
    }

    // если в обоих случаях 0 — отдадим диагностику
    if (!usedDateField) {
      return json(res, 200, {
        ok: true,
        summary: null,
        ...(debug ? { diag: { reason: 'no_orders_for_date', triedDateFields: DATE_FIELDS_TRY, date } } : {})
      });
    }

    // отфильтруем:
    // 1) не отменён
    // 2) линк Org содержит orgRecId
    // (3) персональный режим — ещё и employeeID совпадает
    const filterByOrg = (rec) => {
      const f = rec.fields || {};
      const link = f[FLD_ORDER_ORG_LINK];
      if (Array.isArray(link)) return link.includes(orgRecId);
      return link === orgRecId;
    };

    const activeOnDate = onDate.filter((o) => !isCancelled(o.fields?.[FLD_STATUS]));

    if (String(scope || '').toLowerCase() === 'org') {
      // По всей организации
      const suitable = activeOnDate.filter(filterByOrg);
      const first = suitable[0] || null;
      if (!first) {
        return json(res, 200, {
          ok: true,
          summary: null,
          ...(debug ? { diag: { mode: 'org', usedDateField, onDate: onDate.length, activeOnDate: activeOnDate.length, orgRecId } } : {})
        });
      }
      return json(res, 200, {
        ok: true,
        summary: { orderId: first.id, date, status: first.fields?.[FLD_STATUS] || '', lines: [] },
        ...(debug ? { diag: { mode: 'org', usedDateField, matched: first.id, onDate: onDate.length } } : {})
      });
    } else {
      // Персональный
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });
      const mine = activeOnDate.find((o) => {
        const empLink = Array.isArray(o.fields?.[FLD_EMP_LINK]) ? o.fields[FLD_EMP_LINK][0] : o.fields?.[FLD_EMP_LINK];
        return empLink === employeeID && filterByOrg(o);
      });
      if (!mine) {
        return json(res, 200, {
          ok: true,
          summary: null,
          ...(debug ? { diag: { mode: 'employee', usedDateField, onDate: onDate.length, activeOnDate: activeOnDate.length, orgRecId } } : {})
        });
      }
      return json(res, 200, {
        ok: true,
        summary: { orderId: mine.id, date, status: mine.fields?.[FLD_STATUS] || '', lines: [] },
        ...(debug ? { diag: { mode: 'employee', usedDateField, matched: mine.id, onDate: onDate.length } } : {})
      });
    }
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
