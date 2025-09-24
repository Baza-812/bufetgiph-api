// api/order.js — Employee order (with cutoff/HR cutoff, idempotency, HR on-behalf)

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');
const DEFAULT_TZ = env('DEFAULT_TZ','Europe/Bucharest');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  MENU:       env('TBL_MENU',       'Menu'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
  REQLOG:     env('TBL_REQLOG',     'Request Log'),
};

const F = {
  // Employees
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),
  EMP_ROLE:       env('FLD_EMP_ROLE',       'Role'),

  // Orders
  ORDER_EMPLOYEE: env('FLD_ORDER_EMPLOYEE', 'Employee'),
  ORDER_MB_LINK:  env('FLD_ORDER_MB_LINK',  'Meal Boxes'),
  ORDER_OL_LINK:  env('FLD_ORDER_OL_LINK',  'Order Lines'),

  // Meal Boxes
  MB_ORDER: env('FLD_MB_ORDER', 'Order'),
  MB_MAIN:  env('FLD_MB_MAIN',  'Main (Menu Item)'),
  MB_SIDE:  env('FLD_MB_SIDE',  'Side (Menu Item)'),
  MB_QTY:   env('FLD_MB_QTY',   'Quantity'),
  MB_TYPE:  env('FLD_MB_TYPE',  'Line Type'),

  // Order Lines
  OL_ORDER: env('FLD_OL_ORDER', 'Order'),
  OL_ITEM:  env('FLD_OL_ITEM',  'Item (Menu Item)'),
  OL_QTY:   env('FLD_OL_QTY',   'Quantity'),
  OL_TYPE:  env('FLD_OL_TYPE',  'Line Type'),

  // Orgs
  ORG_ID:         env('FLD_ORG_ID',        'OrgID'),
  ORG_TZ:         env('FLD_ORG_TZ',        'Time Zone'),
  ORG_CUTOFF:     env('FLD_ORG_CUTOFF',    'Cutoff Time'),    // "HH:mm" or Time
  ORG_HR_CUTOFF:  env('FLD_ORG_HR_CUTOFF', 'HR Cutoff Time'), // "HH:mm" or Time

  // Request Log
  RL_KEY:     env('FLD_RL_KEY','Key'),
  RL_DATE:    env('FLD_RL_DATE','Date'),
  RL_EMP:     env('FLD_RL_EMP','Employee'),
  RL_TOKEN:   env('FLD_RL_TOKEN','Client Token'),
  RL_ORDER:   env('FLD_RL_ORDER','Order'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.end(JSON.stringify(data));
}
const atHeaders = () => ({ Authorization:`Bearer ${APIKEY}`, 'Content-Type':'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;
async function atGet(t, params={}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{
    if (Array.isArray(v)) v.forEach(vv=>usp.append(k,vv)); else if (v!=null) usp.append(k,v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`); return r.json();
}
async function atPost(t, body) {
  const r = await fetch(atUrl(t), { method:'POST', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT POST ${t}: ${r.status} ${await r.text()}`); return r.json();
}
async function atPatch(t, body) {
  const r = await fetch(atUrl(t), { method:'PATCH', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`); return r.json();
}
const one = (a)=> (Array.isArray(a)&&a.length?a[0]:null);
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

async function readBody(req){
  if (req.body && typeof req.body==='object') return req.body;
  if (typeof req.body==='string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(res=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{res(d?JSON.parse(d):{});}catch{res({});}}); });
}

// --- TZ helpers ---
function getTzOffsetMinutes(tz, date){
  const f = new Intl.DateTimeFormat('en-US',{ timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = Object.fromEntries(f.formatToParts(date).map(o=>[o.type, o.value]));
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime())/60000;
}
function localToUtc(tz, y,m,d,hh,mm){
  const guessUTC = Date.UTC(y,m-1,d,hh,mm,0);
  const off = getTzOffsetMinutes(tz, new Date(guessUTC));
  return new Date(guessUTC - off*60000);
}
function parseHHMM(v){
  if (!v) return null;
  if (typeof v==='string'){
    const m = v.match(/^(\d{1,2}):(\d{2})/); if (!m) return null; return {hh:+m[1], mm:+m[2]};
  }
  // Airtable "time" может прийти ISO -> возьмём часы/минуты по UTC части
  const dt = new Date(v); if (isNaN(dt)) return null;
  return { hh: dt.getUTCHours(), mm: dt.getUTCMinutes() };
}

// --- cutoff check ---
async function getOrgByCode(orgCode){
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${orgCode}'`,
    maxRecords: 1,
  });
  return one(r.records);
}
function canOrderNow(nowUtc, deliveryDate, orgRec, isHR){
  const tz = (orgRec?.fields?.[F.ORG_TZ]) || DEFAULT_TZ;
  const ct = parseHHMM(orgRec?.fields?.[F.ORG_CUTOFF]);
  if (!ct) return { ok:false, reason:'org cutoff not set' };

  const [Y,M,D] = deliveryDate.split('-').map(Number);
  // cutoff: previous day at cutoff time
  const prev = new Date(Date.UTC(Y, M-1, D)); prev.setUTCDate(prev.getUTCDate()-1);
  const cutoffUtc = localToUtc(tz, prev.getUTCFullYear(), prev.getUTCMonth()+1, prev.getUTCDate(), ct.hh, ct.mm);

  if (nowUtc <= cutoffUtc) return { ok:true, mode:'normal', cutoffUtc: cutoffUtc.toISOString() };

  const hrct = parseHHMM(orgRec?.fields?.[F.ORG_HR_CUTOFF]);
  if (isHR && hrct){
    const hrUtc = localToUtc(tz, Y, M, D, hrct.hh, hrct.mm);
    if (nowUtc <= hrUtc) return { ok:true, mode:'hr', cutoffUtc: cutoffUtc.toISOString(), hrCutoffUtc: hrUtc.toISOString() };
  }
  return { ok:false, reason:'deadline passed', cutoffUtc: cutoffUtc.toISOString() };
}

module.exports = async (req,res)=>{
  try{
    if (req.method==='OPTIONS') return json(res,200,{ok:true});
    if (req.method!=='POST') return json(res,405,{error:'POST only'});
    if (!BASE || !APIKEY) return json(res,500,{error:'Missing AIRTABLE_* env'});

    const body = await readBody(req);
    const { employeeID, org, token, date, included, clientToken, forEmployeeID } = body||{};
    if (!employeeID || !org || !token || !date) return json(res,400,{error:'employeeID, org, token, date required'});

    // requester
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS, F.EMP_ROLE],
      maxRecords: 1,
    });
    const requester = one(empResp.records);
    if (!requester) return json(res,404,{error:'employee not found'});
    const ef = requester.fields||{};
    const reqOrg = (Array.isArray(ef[F.EMP_ORG_LOOKUP])? ef[F.EMP_ORG_LOOKUP][0]: ef[F.EMP_ORG_LOOKUP]) || null;
    if (reqOrg !== org) return json(res,403,{error:'employee not allowed (org mismatch)'});
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) return json(res,403,{error:'invalid token'});
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase()!=='active') return json(res,403,{error:'employee not active'});

    const isHR = String(ef[F.EMP_ROLE]||'').toUpperCase().includes('HR');

    // target employee (for on-behalf)
    let targetEmpId = employeeID;
    if (forEmployeeID && forEmployeeID !== employeeID){
      if (!isHR) return json(res,403,{error:'only HR can order on behalf'});
      // verify same org
      const te = await atGet(TABLE.EMPLOYEES, { filterByFormula:`RECORD_ID()='${forEmployeeID}'`, 'fields[]':[F.EMP_ORG_LOOKUP, F.EMP_STATUS], maxRecords:1 });
      const teRec = one(te.records);
      if (!teRec) return json(res,404,{error:'target employee not found'});
      const teOrg = (Array.isArray(teRec.fields[F.EMP_ORG_LOOKUP])? teRec.fields[F.EMP_ORG_LOOKUP][0]: teRec.fields[F.EMP_ORG_LOOKUP])||null;
      if (teOrg !== org) return json(res,403,{error:'target employee in another org'});
      if (teRec.fields[F.EMP_STATUS] && String(teRec.fields[F.EMP_STATUS]).toLowerCase()!=='active') return json(res,403,{error:'target employee not active'});
      targetEmpId = teRec.id;
    }

    // date available in Menu?
    const menuResp = await atGet(TABLE.MENU, {
      filterByFormula: `IS_SAME({Date}, DATETIME_PARSE('${date}'), 'day')`,
      'fields[]':['Date'],
      maxRecords:1
    });
    if (!menuResp.records?.length) return json(res,400,{error:'date is not available'});

    // org cutoff logic
    const orgRec = await getOrgByCode(org);
    if (!orgRec) return json(res,400,{error:'organization not found'});
    const nowUtc = new Date();
    const win = canOrderNow(nowUtc, date, orgRec, isHR);
    if (!win.ok) return json(res,403,{error:win.reason, cutoffUtc:win.cutoffUtc, hrCutoffUtc:win.hrCutoffUtc});

    // Idempotency
    let existingOrderId = null;
    if (clientToken){
      const key = `${date}|${targetEmpId}|${clientToken}`;
      const q = await atGet(TABLE.REQLOG, { filterByFormula:`{${F.RL_KEY}}='${key}'`, maxRecords:1, 'fields[]':[F.RL_ORDER] });
      const hit = one(q.records);
      const oid = hit?.fields?.[F.RL_ORDER]?.[0];
      if (oid){ return json(res,200,{ ok:true, orderId: oid, idempotent:true }); }
    }
    // ===== DUPLICATE GUARD: one order per employee per date =====
async function findExistingEmployeeOrder(date, empId) {
  // Активный = любой статус, кроме "Cancelled" (или пустой)
  const formula = `
    AND(
      {Order Type}='Employee',
      {Order Date}='${date}',
      FIND('${empId}', ARRAYJOIN({Employee} & ""))>0,
      OR({Status}='', {Status}!='Cancelled')
    )`;
  const res = await atList(TABLE.ORDERS, { maxRecords: 1, filterByFormula: formula });
  return res?.records?.[0]?.id || null;
}

// ...внутри основного handler после всех проверок окна/прав:
const existingOrderId = await findExistingEmployeeOrder(date, targetEmpId);
if (existingOrderId) {
  // Пишем лог попытки (не обязательн., но полезно для аудита)
  if (clientToken) {
    const key = `${date}|${targetEmpId}|${clientToken}`;
    try {
      await atPost(TABLE.REQLOG, {
        typecast: true,
        records: [{
          fields: {
            [F.RL_KEY]: key,
            [F.RL_DATE]: date,
            [F.RL_EMP]: [targetEmpId],
            [F.RL_TOKEN]: clientToken,
            [F.RL_ORDER]: [existingOrderId]
          }
        }]
      });
    } catch (e) {
      console.warn('Request Log write (duplicate) failed:', e?.message || String(e));
    }
  }

  return json({
    ok: true,
    duplicate: true,
    orderId: existingOrderId,
    reason: 'employee already has an active order for this date'
  });
}


    // Create order
    const orderCreate = await atPost(TABLE.ORDERS, {
      typecast:true,
      records:[{ fields:{ 'Order Date': date, 'Order Type':'Employee', [F.ORDER_EMPLOYEE]: [targetEmpId] } }]
    });
    const orderRec = one(orderCreate.records); if (!orderRec) return json(res,500,{error:'order create failed'});
    const orderId = orderRec.id;

    const ids = { mealBoxes:[], orderLines:[] };
    const writeLog = {};

    // Meal Box
    if (included?.mainId || included?.sideId){
      const mbFields = { [F.MB_ORDER]:[orderId], [F.MB_QTY]:1, [F.MB_TYPE]:'Included' };
      if (included.mainId) mbFields[F.MB_MAIN] = [included.mainId];
      if (included.sideId) mbFields[F.MB_SIDE] = [included.sideId];
      const mbResp = await atPost(TABLE.MEALBOXES,{ typecast:true, records:[{ fields: mbFields }]});
      (mbResp.records||[]).forEach(r=>ids.mealBoxes.push(r.id));
      writeLog.mb_main = { ok:[F.MB_MAIN] }; if (included.sideId) writeLog.mb_side = { ok:[F.MB_SIDE] };
    }

    // Extras → Order Lines (до 2 шт.)
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0,2) : [];
    if (extras.length){
      const olResp = await atPost(TABLE.ORDERLINES,{
        typecast:true,
        records: extras.map(itemId => ({ fields:{ [F.OL_ORDER]:[orderId], [F.OL_ITEM]:[itemId], [F.OL_QTY]:1, [F.OL_TYPE]:'Included' }}))
      });
      (olResp.records||[]).forEach(r=>ids.orderLines.push(r.id));
      writeLog.ol_item = { ok:[F.OL_ITEM] };
    }

    // patch back-links
    const patchFields={}; if (ids.mealBoxes.length) patchFields[F.ORDER_MB_LINK]=ids.mealBoxes; if (ids.orderLines.length) patchFields[F.ORDER_OL_LINK]=ids.orderLines;
    if (Object.keys(patchFields).length){ await atPatch(TABLE.ORDERS,{ typecast:true, records:[{ id:orderId, fields:patchFields }]}); }

    // Request Log (if clientToken)
    if (clientToken){
      const key = `${date}|${targetEmpId}|${clientToken}`;
      await atPost(TABLE.REQLOG, { typecast:true, records:[{ fields:{ [F.RL_KEY]: key, [F.RL_DATE]: date, [F.RL_EMP]: [targetEmpId], [F.RL_TOKEN]: clientToken, [F.RL_ORDER]: [orderId] } }]});
    }

    // read-back
    await sleep(150);
    const rbOrder = one((await atGet(TABLE.ORDERS, { filterByFormula:`RECORD_ID()='${orderId}'`, 'fields[]':[F.ORDER_EMPLOYEE, F.ORDER_MB_LINK, F.ORDER_OL_LINK], maxRecords:1 })).records);
    const rbMB = ids.mealBoxes.length ? await atGet(TABLE.MEALBOXES,{ filterByFormula:`OR(${ids.mealBoxes.map(id=>`RECORD_ID()='${id}'`).join(',')})` }) : { records:[] };
    const rbOL = ids.orderLines.length ? await atGet(TABLE.ORDERLINES,{ filterByFormula:`OR(${ids.orderLines.map(id=>`RECORD_ID()='${id}'`).join(',')})` }) : { records:[] };

    return json(res,200,{ ok:true, orderId, ids, writeLog, window:win, readBack:{ order:rbOrder, mealBoxes:rbMB.records||[], orderLines:rbOL.records||[] } });
  }catch(e){
    console.error('order.js failed:', e);
    return json(res,500,{ error: e.message || String(e) });
  }
};
