// /lib/handlers/order_summary.js
// Поиск заказа по дате/организации через поля OrderDateISO и Org IDs

const { json, atGet, TABLE, F } = require('../utils');

const lower = (v) => String(v || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled';
};

// Жёстко используем известные поля (с фолбэком на F.* если настроено в utils)
const FLD_ORDER_DATE_ISO = F.ORDER_DATE_ISO || 'OrderDateISO';
const FLD_ORG_IDS        = F.ORDER_ORG_IDS  || 'Org IDs';
const FLD_STATUS         = F.ORDER_STATUS   || 'Status';
const FLD_EMP_LINK       = F.ORDER_EMPLOYEE || 'Employee';
// Если ведёте тип заказа:
const FLD_ORDER_TYPE     = 'Order Type'; // если поля нет — формула всё равно пройдёт (LEN() вернёт 0)

function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

// Вхождение org в Org IDs (строка/луккап):
function orgMatchFormula(org) {
  const safe = String(org).replace(/'/g, "\\'");
  const f1 = `{${FLD_ORG_IDS}}='${safe}'`;
  const f2 = `FIND('${safe}', {${FLD_ORG_IDS}})`;               // если строка
  const f3 = `FIND('${safe}', ARRAYJOIN({${FLD_ORG_IDS}}))`;     // если массив/луккап
  return `OR(${f1}, ${f2}, ${f3})`;
}

const notCancelledFormula = `NOT(OR(LOWER({${FLD_STATUS}})='cancelled', LOWER({${FLD_STATUS}})='canceled'))`;

// БЫЛО: IS_BLANK(...) — вызывало 422
// СТАЛО: LEN(...)=0 — стабильный способ «пустое или 'manager'»
const managerTypeFormula = `OR(LEN({${FLD_ORDER_TYPE}})=0, LOWER({${FLD_ORDER_TYPE}})='manager')`;

async function findOneByFormula(filter) {
  const r = await atGet(TABLE.ORDERS, {
    maxRecords: 1,
    filterByFormula: filter
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

    let filter = '';
    if (String(scope || '').toLowerCase() === 'org') {
      // Любой активный заказ на дату в этой орг. (мягко требуем Manager)
      const byOrg = orgMatchFormula(org);
      filter = `AND(${byDate}, ${byOrg}, ${notCancelledFormula}, ${managerTypeFormula})`;
    } else {
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });
      const byEmp = eqStr(FLD_EMP_LINK, employeeID);
      filter = `AND(${byDate}, ${byEmp}, ${notCancelledFormula})`;
    }

    const rec = await findOneByFormula(filter);
    if (!rec) {
      return json(res, 200, {
        ok: true,
        summary: null,
        ...(debug ? { diag: { mode: (scope || 'employee'), filter } } : {})
      });
    }

    const f = rec.fields || {};
    const summary = {
      orderId: rec.id,
      date:    f[FLD_ORDER_DATE_ISO] || date,
      status:  f[FLD_STATUS] || '',
      lines:   []
    };

    return json(res, 200, {
      ok: true,
      summary,
      ...(debug ? { diag: { mode: (scope || 'employee'), filter, matched: rec.id } } : {})
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};
