// /api/busy.js — проверка занятости по датам напрямую через Airtable
const { json, withRateLimit, atGet, TABLE, F } = require('../lib/utils');

// формула по сотруднику: ищем по линк-полю Employee (ARRAYJOIN)
// и дополнительно (если задано в .env) по текстовому/lookup полю с recID
function employeeFormula(employeeID) {
  const byLink = `SEARCH('${employeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}})) > 0`;
  const fld = (F.ORDER_EMPLOYEEID || '').trim(); // см. .env FLD_ORDER_EMPLOYEEID=EmployeeID
  if (fld) {
    const byText = `{${fld}}='${employeeID}'`;
    return `OR(${byLink}, ${byText})`;
  }
  return byLink;
}

// статус считаем “активным”, если НЕ равен Cancelled
function activeStatusFormula() {
  // подправь при необходимости под свои статусы
  return `NOT({${F.ORDER_STATUS}}='Cancelled')`;
}

// Order Type == 'Employee' (если поле есть)
function orderTypeFormula() {
  return `{${F.ORDER_TYPE}}='Employee'`;
}

// Организация: либо по коду Org (lookup/текст), либо через ссылку если нужен другой способ
function orgFormula(orgCode) {
  return `{${F.ORDER_ORG_ID}}='${orgCode}'`;
}

// формула для конкретной даты (день к дню)
function dateFormula(iso) {
  return `IS_SAME({${F.ORDER_DATE}}, '${iso}', 'day')`;
}

function buildFilter({ employeeID, org, date }) {
  const parts = [
    orgFormula(org),
    dateFormula(date),
    orderTypeFormula(),
    activeStatusFormula(),
    employeeFormula(employeeID),
  ];
  return `AND(${parts.join(',')})`;
}

module.exports = withRateLimit(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

    const { employeeID, org, token, dates = '', debug } = req.query || {};
    if (!employeeID || !org || !token) {
      return json(res, 400, { error: 'employeeID, org, token required' });
    }

    const dateList = String(dates || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const busy = {};
    const dbg  = [];

    for (const d of dateList) {
      const filterByFormula = buildFilter({ employeeID, org, date: d });

      try {
        // одна запись нам достаточна, чтобы понять “занято”
        const resp = await atGet(TABLE.ORDERS, {
          maxRecords: 1,
          filterByFormula,
          // можно ограничить полями, чтобы ответ был легче
          "fields[]": [F.ORDER_NO],
        });

        const has = Array.isArray(resp?.records) && resp.records.length > 0;
        busy[d] = !!has;

        if (debug) {
          dbg.push({
            date: d,
            filterByFormula,
            returned: has ? 1 : 0,
          });
        }
      } catch (e) {
        // не роняем 500 — считаем свободным
        busy[d] = false;
        if (debug) {
          dbg.push({
            date: d,
            filterByFormula,
            error: e?.message || String(e),
          });
        }
      }
    }

    return json(res, 200, { ok: true, busy, ...(debug ? { debug: dbg } : {}) });
  } catch (e) {
    // на всякий случай — дружелюбная ошибка вместо 500
    return json(res, 200, {
      ok: true,
      busy: {},
      debug: [{ error: e?.message || String(e), where: 'top-level' }],
    });
  }
});
