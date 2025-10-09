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
    const dates = String(q.dates || '').split(',').map(s=>s.trim()).filter(Boolean);
    const debug = String(q.debug || '') === '1';

    if (!employeeID) return send(res, 200, { ok:false, error:'employeeID required' });
    if (!dates.length) return send(res, 200, { ok:true, busy:{} });

    const busy = {};
    const dbg  = [];

    for (const d of dates) {
      const filterByFormula = `AND(${dateFormula(d)}, ${employeeFormula(employeeID)}, ${activeFormula()})`;
      try {
        const resp = await atGet(TABLE_ORDERS, {
          maxRecords: 1,
          filterByFormula,
          'fields[]': [F_ORDER_DATE, F_ORDER_STATUS, F_ORDER_EMPLOYEE]
        });
        const count = Array.isArray(resp?.records) ? resp.records.length : 0;
        busy[d] = count > 0;
        if (debug) dbg.push({ date:d, filterByFormula, count });
      } catch (e) {
        // не валим 500 — помечаем свободно и пишем причину
        busy[d] = false;
        if (debug) dbg.push({ date:d, filterByFormula, error: e?.message || String(e) });
      }
    }

    return send(res, 200, { ok:true, busy, ...(debug ? { debug: dbg } : {}) });
  } catch (e) {
    // вообще никаких 500 наружу — всё в теле
    return send(res, 200, { ok:false, error: e?.message || String(e) });
  }
};
