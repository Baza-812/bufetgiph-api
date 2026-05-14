// /api/busy.js — минимальная версия без внешних утилит, с подробным debug
// Требуются переменные окружения:
//   AIRTABLE_BASE_ID, AIRTABLE_API_KEY,  TBL_ORDERS (Orders по умолчанию)
//   FLD_ORDER_DATE ('Order Date'), FLD_ORDER_STATUS ('Status'),
//   FLD_ORDER_EMPLOYEE ('Employee' — link), [опц] FLD_ORDER_EMPLOYEEID ('EmployeeID' — текст/lookup)

const BASE   = process.env.AIRTABLE_BASE_ID;
const APIKEY = process.env.AIRTABLE_API_KEY;

const TABLE_ORDERS = process.env.TBL_ORDERS || 'Orders';

const F_ORDER_DATE     = process.env.FLD_ORDER_DATE     || 'Order Date';
const F_ORDER_STATUS   = process.env.FLD_ORDER_STATUS   || 'Status';
const F_ORDER_EMPLOYEE = process.env.FLD_ORDER_EMPLOYEE || 'Employee';
const F_ORDER_EMPLOYEEID = (process.env.FLD_ORDER_EMPLOYEEID || '').trim(); // опционально

const TABLE_EMPLOYEES = process.env.TBL_EMPLOYEES || 'Employees';
const F_EMP_TOKEN = process.env.FLD_EMP_TOKEN || 'Order Token';
const F_EMP_ORG_LOOKUP = process.env.FLD_EMP_ORG_LOOKUP || 'OrgID (from Organization)';

const { verifyDinnerCloneBelongsToPrimary } = require('../dinner_clone');

// ——— утилиты ответа
function send(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.end(JSON.stringify(data));
}
async function atGet(table, params = {}) {
  const usp = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => usp.append(k,x));
    else if (v != null) usp.append(k, String(v));
  }
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}?${usp}`;
  const r = await fetch(url, { headers: { Authorization:`Bearer ${APIKEY}` } });
  const txt = await r.text();
  let js;
  try { js = JSON.parse(txt); } catch { js = { raw: txt }; }
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${txt}`);
  return js;
}

// ——— формулы Airtable
const dateFormula   = iso => `IS_SAME({${F_ORDER_DATE}}, '${iso}', 'day')`;
const activeFormula = ()  => `NOT({${F_ORDER_STATUS}}='Cancelled')`;
function employeeFormula(employeeID) {
  const byLink = `SEARCH('${employeeID}', ARRAYJOIN({${F_ORDER_EMPLOYEE}})) > 0`;
  if (F_ORDER_EMPLOYEEID) {
    const byText = `{${F_ORDER_EMPLOYEEID}}='${employeeID}'`;
    return `OR(${byLink}, ${byText})`;
  }
  return byLink;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok:true });
    if (req.method !== 'GET')     return send(res, 405, { ok:false, error:'GET only' });

    // базовая проверка env — чтобы не было немой 500
    const missing = [];
    if (!BASE)   missing.push('AIRTABLE_BASE_ID');
    if (!APIKEY) missing.push('AIRTABLE_API_KEY');
    if (missing.length) {
      return send(res, 200, { ok:false, error:'missing_env', missing });
    }

    const q = req.query || {};
    const employeeID = String(q.employeeID || '').trim();
    const dinnerEmployeeID = String(q.dinnerEmployeeID || '').trim();
    const orgCode = String(q.org || '').trim();
    const token = String(q.token || '').trim();
    const dates = String(q.dates || '').split(',').map(s=>s.trim()).filter(Boolean);
    const debug = String(q.debug || '') === '1';

    if (!employeeID) return send(res, 200, { ok:false, error:'employeeID required' });
    if (!dates.length) return send(res, 200, { ok:true, busy:{}, awaitingPayment:{} });

    if (dinnerEmployeeID) {
      if (!orgCode || !token) {
        return send(res, 200, { ok: false, error: 'org and token required when dinnerEmployeeID is set' });
      }
      try {
        const empResp = await atGet(TABLE_EMPLOYEES, {
          filterByFormula: `RECORD_ID()='${employeeID.replace(/'/g, "\\'")}'`,
          maxRecords: 1,
          'fields[]': [F_EMP_ORG_LOOKUP, F_EMP_TOKEN],
        });
        const rec = Array.isArray(empResp?.records) ? empResp.records[0] : null;
        if (!rec) return send(res, 200, { ok: false, error: 'employee not found' });
        const f = rec.fields || {};
        const empOrg = Array.isArray(f[F_EMP_ORG_LOOKUP]) ? f[F_EMP_ORG_LOOKUP][0] : f[F_EMP_ORG_LOOKUP];
        if (String(empOrg || '') !== orgCode) return send(res, 200, { ok: false, error: 'org mismatch' });
        if (String(f[F_EMP_TOKEN] || '') !== token) return send(res, 200, { ok: false, error: 'invalid token' });
        const v = await verifyDinnerCloneBelongsToPrimary(dinnerEmployeeID, employeeID);
        if (!v.ok) return send(res, 200, { ok: false, error: v.error });
      } catch (e) {
        return send(res, 200, { ok: false, error: e?.message || String(e) });
      }
    }

    const busy = {};
    const awaitingPayment = {};
    const dinnerBusy = {};
    const dinnerAwaitingPayment = {};
    const dbg = [];

    async function scanDates(empId, outBusy, outAwait) {
      for (const d of dates) {
        const filterByFormula = `AND(${dateFormula(d)}, ${employeeFormula(empId)}, ${activeFormula()})`;
        try {
          const resp = await atGet(TABLE_ORDERS, {
            maxRecords: 1,
            filterByFormula,
            'fields[]': [F_ORDER_DATE, F_ORDER_STATUS, F_ORDER_EMPLOYEE]
          });
          const rec = Array.isArray(resp?.records) ? resp.records[0] : null;
          const count = rec ? 1 : 0;
          outBusy[d] = count > 0;
          const st = String(rec?.fields?.[F_ORDER_STATUS] ?? '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '');
          outAwait[d] = count > 0 && st === 'awaitingpayment';
          if (debug) dbg.push({ date:d, empId, filterByFormula, count, status: rec?.fields?.[F_ORDER_STATUS] });
        } catch (e) {
          outBusy[d] = false;
          outAwait[d] = false;
          if (debug) dbg.push({ date:d, empId, filterByFormula, error: e?.message || String(e) });
        }
      }
    }

    await scanDates(employeeID, busy, awaitingPayment);
    if (dinnerEmployeeID) {
      await scanDates(dinnerEmployeeID, dinnerBusy, dinnerAwaitingPayment);
    }

    return send(res, 200, {
      ok:true,
      busy,
      awaitingPayment,
      ...(dinnerEmployeeID ? { dinnerBusy, dinnerAwaitingPayment } : {}),
      ...(debug ? { debug: dbg } : {}),
    });
  } catch (e) {
    // вообще никаких 500 наружу — всё в теле
    return send(res, 200, { ok:false, error: e?.message || String(e) });
  }
};
