// /lib/handlers/order_summary.js
// Поиск заказа по дате/организации через OrderDateISO + линк-поле Org

const { json, atGet, TABLE, F } = require('../utils');

const lower = (v) => String(v || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled';
};

// Жёстко используем известные поля из структуры:
const FLD_ORDER_DATE_ISO = 'OrderDateISO';     // есть в Orders
const FLD_STATUS         = F.ORDER_STATUS || 'Status';
const FLD_EMP_LINK       = F.ORDER_EMPLOYEE || 'Employee';
const FLD_ORDER_TYPE     = 'Order Type';       // опционально
const FLD_ORDER_ORG_LINK = 'Org';              // ЛИНК на Organizations (из структуры)

function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

const notCancelledFormula = `NOT(OR(LOWER({${FLD_STATUS}})='cancelled', LOWER({${FLD_STATUS}})='canceled'))`;
const managerTypeFormula  = `OR(LEN({${FLD_ORDER_TYPE}})=0, LOWER({${FLD_ORDER_TYPE}})='manager')`;

// Находим запись Organizations по OrgID и возвращаем её recordId
async function getOrgRecordIdByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    maxRecords: 1,
    filterByFormula: eqStr(F.ORG_ID || 'OrgID', orgCode),
    // без fields[] — чтобы не ловить 422
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

async function findOneOrderByFormula(filter) {
  const r = await atGet(TABLE.ORDERS, {
    maxRecords: 1,
    filterByFormula: filter,
  });
  return (r.records || [])[0] || null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, employeeID, date, scope, debug } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    const byDate = eqStr(FLD_ORDER_DATE_ISO, date);

    // персональный режим (как было)
    if (lower(scope) !== 'org') {
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });
      const byEmp = eqStr(FLD_EMP_LINK, employeeID);
      const filter = `AND(${byDate}, ${byEmp}, ${notCancelledFormula})`;

      const rec = await findOneOrderByFormula(filter);
      if (!rec) {
        return json(res, 200, { ok: true, summary: null, ...(debug ? { diag: { mode: 'employee', filter } } : {}) });
      }
      const f = rec.fields || {};
      return json(res, 200, {
        ok: true,
        summary: { orderId: rec.id, date: f[FLD_ORDER_DATE_ISO] || date, status: f[FLD_STATUS] || '', lines: [] },
        ...(debug ? { diag: { mode: 'employee', filter, matched: rec.id } } : {})
      });
    }

    // режим всей организации: берём link-поле Org
    const orgRecId = await getOrgRecordIdByCode(org);
    if (!orgRecId) {
      return json(res, 200, { ok: true, summary: null, ...(debug ? { diag: { mode: 'org', reason: 'org_record_not_found' } } : {}) });
    }
    const byOrgLink = eqStr(FLD_ORDER_ORG_LINK, orgRecId);
    const filter = `AND(${byDate}, ${byOrgLink}, ${notCancelledFormula}, ${managerTypeFormula})`;

    const rec = await findOneOrderByFormula(filter);
    if (!rec) {
      return json(res, 200, { ok: true, summary: null, ...(debug ? { diag: { mode: 'org', filter, orgRecId } } : {}) });
    }

    const f = rec.fields || {};
    return json(res, 200, {
      ok: true,
      summary: { orderId: rec.id, date: f[FLD_ORDER_DATE_ISO] || date, status: f[FLD_STATUS] || '', lines: [] },
      ...(debug ? { diag: { mode: 'org', filter, orgRecId, matched: rec.id } } : {})
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
