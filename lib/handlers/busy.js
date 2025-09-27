// /api/busy.js
const { json, withRateLimit, atGet, TABLE, F } = require('../lib/utils');

// формула по сотруднику: link-поле + (опционально) текстовое/lookup поле с recID
function employeeFormula(employeeID) {
  const byLink = `SEARCH('${employeeID}', ARRAYJOIN({${F.ORDER_EMPLOYEE}})) > 0`;
  const fld = (F.ORDER_EMPLOYEEID || '').trim?.() || '';
  if (fld) {
    const byText = `{${fld}}='${employeeID}'`;
    return `OR(${byLink}, ${byText})`;
  }
  return byLink;
}

function isSameDayFormula(field, isoDate) {
  return `IS_SAME({${field}}, DATETIME_PARSE('${isoDate}'), 'day')`;
}
function activeStatusFormula() {
  // при необходимости расширь список
  return `OR({${F.ORDER_STATUS}}='New',{${F.ORDER_STATUS}}='Active',{${F.ORDER_STATUS}}='Approved')`;
}
function employeeTypeFormula() {
  return `{${F.ORDER_TYPE}}='Employee'`;
}
function orgFormula(org) {
  return `{${F.ORDER_ORG_ID}}='${org}'`;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const { employeeID, org, dates = '', debug: wantDebug } = req.query || {};
  if (!employeeID || !org) return json(res, 400, { error: 'employeeID and org are required' });

  const list = String(dates || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const busy = {};
  const debug = [];

  for (const d of list) {
    const filterByFormula = `AND(${[
      employeeFormula(employeeID),
      orgFormula(org),
      isSameDayFormula(F.ORDER_DATE, d),
      employeeTypeFormula(),
      activeStatusFormula(),
    ].join(',')})`;

    try {
      const resp = await atGet(TABLE.ORDERS, {
        maxRecords: 1,
        filterByFormula,
        "fields[]": [F.ORDER_DATE, F.ORDER_STATUS, F.ORDER_TYPE, F.ORDER_ORG_ID],
      });

      const has = Array.isArray(resp?.records) && resp.records.length > 0;
      busy[d] = !!has;

      if (wantDebug) {
        debug.push({
          date: d,
          filterByFormula,
          found: has ? resp.records[0]?.id : null,
        });
      }
    } catch (e) {
      // НЕ роняем роут, а возвращаем диагностику
      busy[d] = false;
      if (wantDebug) {
        debug.push({
          date: d,
          filterByFormula,
          error: e?.message || String(e),
        });
      }
    }
  }

  return json(res, 200, { ok: true, busy, ...(wantDebug ? { debug } : {}) });
});
