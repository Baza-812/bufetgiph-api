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
// Опционально, если ведёте тип заказа:
const FLD_ORDER_TYPE     = 'Order Type'; // если поля нет — просто будет undefined

// Безопасный конструктор формулы: сравнение строки (экраним одинарные кавычки)
function eqStr(field, val) {
  const safe = String(val).replace(/'/g, "\\'");
  return `{${field}}='${safe}'`;
}

// Вхождение org в поле Org IDs: поддерживаем и строку, и массив-луккап
// Формула: OR({Org IDs}='org', FIND('org', {Org IDs}), FIND('org', ARRAYJOIN({Org IDs})))
function orgMatchFormula(org) {
  const safe = String(org).replace(/'/g, "\\'");
  const f1 = `{${FLD_ORG_IDS}}='${safe}'`;
  const f2 = `FIND('${safe}', {${FLD_ORG_IDS}})`;               // если строка
  const f3 = `FIND('${safe}', ARRAYJOIN({${FLD_ORG_IDS}}))`;     // если массив/луккап
  return `OR(${f1}, ${f2}, ${f3})`;
}

// Базовый «не отменён»
const notCancelledFormula = `NOT(OR(LOWER({${FLD_STATUS}})='cancelled', LOWER({${FLD_STATUS}})='canceled'))`;

// Мягкая проверка на менеджерский заказ (только если поле присутствует и заполнено)
const managerTypeFormula = `OR(IS_BLANK({${FLD_ORDER_TYPE}}), LOWER({${FLD_ORDER_TYPE}})='manager')`;

async function findOneByFormula(filter) {
  const r = await atGet(TABLE.ORDERS, {
    maxRecords: 1,
    filterByFormula: filter
    // без fields[] — тянем как есть, чтобы не падать на неизвестных полях
  });
  return (r.records || [])[0] || null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const { org, employeeID, date, scope, debug } = req.query || {};
    if (!org || !date) return json(res, 400, { error: 'org and date required' });

    // 1) Собираем формулу по режиму
    let filter = '';
    const byDate = eqStr(FLD_ORDER_DATE_ISO, date);

    if (String(scope || '').toLowerCase() === 'org') {
      // любой активный (не отменённый) заказ на эту дату и организацию
      const byOrg  = orgMatchFormula(org);
      filter = `AND(${byDate}, ${byOrg}, ${notCancelledFormula}, ${managerTypeFormula})`;
    } else {
      // персональный: дата + конкретный employee + не отменён
      if (!employeeID) return json(res, 400, { error: 'employeeID required (scope != org)' });
      const byEmp = eqStr(FLD_EMP_LINK, employeeID);
      filter = `AND(${byDate}, ${byEmp}, ${notCancelledFormula})`;
    }

    // 2) Ищем одну запись
    const rec = await findOneByFormula(filter);
    if (!rec) {
      return json(res, 200, {
        ok: true,
        summary: null,
        ...(debug ? { diag: { mode: (scope || 'employee'), filter } } : {})
      });
    }

    // 3) Собираем краткую сводку (для серости/модалки достаточно)
    const f = rec.fields || {};
    const summary = {
      orderId: rec.id,
      date:    f[FLD_ORDER_DATE_ISO] || date,
      status:  f[FLD_STATUS] || '',
      lines:   [] // тут можно позже нарастить состав из Meal Boxes / Order Lines
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
