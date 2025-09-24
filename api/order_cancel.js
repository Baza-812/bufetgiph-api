// api/order_cancel.js

function env(k,d){ return process.env[k] ?? d; }
const BASE=env('AIRTABLE_BASE_ID'); const APIKEY=env('AIRTABLE_API_KEY'); const DEFAULT_TZ=env('DEFAULT_TZ','Europe/Bucharest');
const TABLE={ ORDERS:env('TBL_ORDERS','Orders'), EMPLOYEES:env('TBL_EMPLOYEES','Employees'), ORGS:env('TBL_ORGS','Organizations') };
const F={
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP','OrgID (from Organization)'), EMP_TOKEN:env('FLD_EMP_TOKEN','Order Token'), EMP_STATUS:env('FLD_EMP_STATUS','Status'), EMP_ROLE:env('FLD_EMP_ROLE','Role'),
  ORDER_EMPLOYEE: env('FLD_ORDER_EMPLOYEE','Employee'), ORDER_MB_LINK:env('FLD_ORDER_MB_LINK','Meal Boxes'), ORDER_OL_LINK:env('FLD_ORDER_OL_LINK','Order Lines'),
  ORG_ID:env('FLD_ORG_ID','OrgID'), ORG_TZ:env('FLD_ORG_TZ','Time Zone'), ORG_CUTOFF:env('FLD_ORG_CUTOFF','Cutoff Time'), ORG_HR_CUTOFF:env('FLD_ORG_HR_CUTOFF','HR Cutoff Time')
};
function json(res,c,d){ res.statusCode=c; res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization'); res.end(JSON.stringify(d)); }
const atHeaders=()=>({Authorization:`Bearer ${APIKEY}`,'Content-Type':'application/json'}); const atUrl=(t)=>`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;
async function atGet(t,p={}){ const usp=new URLSearchParams(); Object.entries(p).forEach(([k,v])=>{ if(Array.isArray(v))v.forEach(vv=>usp.append(k,vv)); else if(v!=null) usp.append(k,v);}); const r=await fetch(`${atUrl(t)}?${usp}`,{headers:atHeaders()}); if(!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`); return r.json(); }
async function atPatch(t,b){ const r=await fetch(atUrl(t),{method:'PATCH',headers:atHeaders(),body:JSON.stringify(b)}); if(!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`); return r.json(); }
const one=(a)=>(Array.isArray(a)&&a.length?a[0]:null);

function getTzOffsetMinutes(tz,date){ const f=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); const p=Object.fromEntries(f.formatToParts(date).map(o=>[o.type,o.value])); const asUTC=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second); return (asUTC - date.getTime())/60000; }
function localToUtc(tz,y,m,d,hh,mm){ const guess=Date.UTC(y,m-1,d,hh,mm,0); const off=getTzOffsetMinutes(tz,new Date(guess)); return new Date(guess - off*60000); }
function parseHHMM(v){ if(!v) return null; if(typeof v==='string'){ const m=v.match(/^(\d{1,2}):(\d{2})/); if(!m) return null; return {hh:+m[1],mm:+m[2]}; } const dt=new Date(v); if(isNaN(dt)) return null; return {hh:dt.getUTCHours(), mm:dt.getUTCMinutes()}; }
async function getOrgByCode(code){ const r=await atGet(TABLE.ORGS,{ filterByFormula:`{${F.ORG_ID}}='${code}'`, maxRecords:1 }); return one(r.records); }
function canOrderNow(nowUtc, deliveryDate, orgRec, isHR){
  const tz=(orgRec?.fields?.[F.ORG_TZ])||DEFAULT_TZ;
  const ct=parseHHMM(orgRec?.fields?.[F.ORG_CUTOFF]); if(!ct) return {ok:false, reason:'org cutoff not set'};
  const [Y,M,D]=deliveryDate.split('-').map(Number);
  const prev=new Date(Date.UTC(Y,M-1,D)); prev.setUTCDate(prev.getUTCDate()-1);
  const cutoffUtc = localToUtc(tz, prev.getUTCFullYear(), prev.getUTCMonth()+1, prev.getUTCDate(), ct.hh, ct.mm);
  if (nowUtc <= cutoffUtc) return {ok:true, mode:'normal'};
  const hrct=parseHHMM(orgRec?.fields?.[F.ORG_HR_CUTOFF]);
  if (isHR && hrct){ const hrUtc=localToUtc(tz,Y,M,D,hrct.hh,hrct.mm); if (nowUtc <= hrUtc) return {ok:true, mode:'hr'}; }
  return {ok:false, reason:'deadline passed'};
}

module.exports = async (req,res)=>{
  try{
    if (req.method==='OPTIONS') return json(res,200,{ok:true});
    if (req.method!=='POST') return json(res,405,{error:'POST only'});
    if (!BASE || !APIKEY) return json(res,500,{error:'Missing AIRTABLE_* env'});
    const chunks=[]; for await (const c of req) chunks.push(c); const bodyStr = Buffer.concat(chunks).toString('utf8'); let body={}; try{body=bodyStr?JSON.parse(bodyStr):{};}catch{}
    const { employeeID, org, token, orderId } = body||{};
    if (!employeeID || !org || !token || !orderId) return json(res,400,{error:'employeeID, org, token, orderId required'});

    // requester
    const er = await atGet(TABLE.EMPLOYEES,{ filterByFormula:`RECORD_ID()='${employeeID}'`, 'fields[]':[F.EMP_ORG_LOOKUP,F.EMP_TOKEN,F.EMP_STATUS,F.EMP_ROLE], maxRecords:1 });
    const requester = one(er.records); if(!requester) return json(res,404,{error:'employee not found'});
    const ef=requester.fields||{};
    const reqOrg=(Array.isArray(ef[F.EMP_ORG_LOOKUP])?ef[F.EMP_ORG_LOOKUP][0]:ef[F.EMP_ORG_LOOKUP])||null;
    if (reqOrg!==org) return json(res,403,{error:'org mismatch'});
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN]!==token) return json(res,403,{error:'invalid token'});
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase()!=='active') return json(res,403,{error:'employee not active'});
    const isHR = String(ef[F.EMP_ROLE]||'').toUpperCase().includes('HR');

    // order
    const or = await atGet(TABLE.ORDERS,{ filterByFormula:`RECORD_ID()='${orderId}'`, 'fields[]':['Order Date',F.ORDER_EMPLOYEE], maxRecords:1 });
    const ord = one(or.records); if(!ord) return json(res,404,{error:'order not found'});
    const targetEmp = ord.fields?.[F.ORDER_EMPLOYEE]?.[0];
    if (targetEmp!==employeeID && !isHR) return json(res,403,{error:'not allowed to cancel others order'});

    // cutoff
    const orgRec = await getOrgByCode(org); if(!orgRec) return json(res,400,{error:'organization not found'});
    const nowUtc=new Date(); const win=canOrderNow(nowUtc, ord.fields['Order Date'].substring(0,10), orgRec, isHR);
    if (!win.ok) return json(res,403,{error:win.reason});

    // cancel
    await atPatch(TABLE.ORDERS,{ typecast:true, records:[{ id:orderId, fields:{ 'Status':'Cancelled', [F.ORDER_MB_LINK]:[], [F.ORDER_OL_LINK]:[] } }] });
    return json(res,200,{ ok:true, orderId, status:'Cancelled' });
  }catch(e){
    console.error('order_cancel failed:', e);
    return json(res,500,{ error: e.message || String(e) });
  }
};
