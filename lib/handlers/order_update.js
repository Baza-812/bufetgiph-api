// api/order_update.js — универсальное обновление заказа (Employee/Manager), с Cutoff/HR Cutoff и опциональным hardDelete

function env(k,d){ return process.env[k] ?? d; }
const BASE = env('AIRTABLE_BASE_ID'); const APIKEY = env('AIRTABLE_API_KEY'); const DEFAULT_TZ = env('DEFAULT_TZ','Europe/Bucharest');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
  MENU:       env('TBL_MENU',       'Menu'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
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
  ORG_ID:        env('FLD_ORG_ID',        'OrgID'),
  ORG_TZ:        env('FLD_ORG_TZ',        'Time Zone'),
  ORG_CUTOFF:    env('FLD_ORG_CUTOFF',    'Cutoff Time'),
  ORG_HR_CUTOFF: env('FLD_ORG_HR_CUTOFF', 'HR Cutoff Time'),
};

function json(res,c,d){ res.statusCode=c; res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization'); res.end(JSON.stringify(d)); }

const atHeaders = ()=>({ Authorization:`Bearer ${APIKEY}`, 'Content-Type':'application/json' });
const atUrl = (t)=>`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(t, params={}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{
    if (Array.isArray(v)) v.forEach(vv=>usp.append(k,vv));
    else if (v!=null) usp.append(k,v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function atPost(t, body){
  const r = await fetch(atUrl(t), { method:'POST', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT POST ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function atPatch(t, body){
  const r = await fetch(atUrl(t), { method:'PATCH', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function atDelete(t, ids){
  const usp = new URLSearchParams(); ids.forEach(id=>usp.append('records[]', id));
  const r = await fetch(`${atUrl(t)}?${usp}`, { method:'DELETE', headers: atHeaders() });
  if (!r.ok) throw new Error(`AT DELETE ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a)=>(Array.isArray(a)&&a.length?a[0]:null);

async function readBody(req){
  if (req.body && typeof req.body==='object') return req.body;
  if (typeof req.body==='string'){ try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(res=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{res(d?JSON.parse(d):{});} catch { res({}); } }); });
}

// ---- Timezone helpers ----
function getTzOffsetMinutes(tz,date){
  const f=new Intl.DateTimeFormat('en-US',{ timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p=Object.fromEntries(f.formatToParts(date).map(o=>[o.type,o.value]));
  const asUTC=Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime())/60000;
}
function localToUtc(tz,y,m,d,hh,mm){
  const guess=Date.UTC(y,m-1,d,hh,mm,0);
  const off=getTzOffsetMinutes(tz,new Date(guess));
  return new Date(guess - off*60000);
}
function parseHHMM(v){
  if (!v) return null;
  if (typeof v==='string') {
    const m=v.match(/^(\d{1,2}):(\d{2})/); if (!m) return null;
    return { hh:+m[1], mm:+m[2] };
  }
  const dt=new Date(v); if (isNaN(dt)) return null;
  return { hh:dt.getUTCHours(), mm:dt.getUTCMinutes() };
}
async function getOrgByCode(code){
  const r=await atGet(TABLE.ORGS, { filterByFormula:`{${F.ORG_ID}}='${code}'`, maxRecords:1 });
  return one(r.records);
}
function canOrderNow(nowUtc, deliveryDate, orgRec, isHRorManager){
  const tz=(orgRec?.fields?.[F.ORG_TZ]) || DEFAULT_TZ;
  const ct=parseHHMM(orgRec?.fields?.[F.ORG_CUTOFF]); if (!ct) return { ok:false, reason:'org cutoff not set' };
  const [Y,M,D]=deliveryDate.split('-').map(Number);

  // the day before, at cutoff time
  const prev = new Date(Date.UTC(Y,M-1,D)); prev.setUTCDate(prev.getUTCDate()-1);
  const cutoffUtc = localToUtc(tz, prev.getUTCFullYear(), prev.getUTCMonth()+1, prev.getUTCDate(), ct.hh, ct.mm);
  if (nowUtc <= cutoffUtc) return { ok:true, mode:'normal', cutoffUtc:cutoffUtc.toISOString() };

  const hrct=parseHHMM(orgRec?.fields?.[F.ORG_HR_CUTOFF]);
  if (isHRorManager && hrct) {
    const hrUtc = localToUtc(tz, Y, M, D, hrct.hh, hrct.mm);
    if (nowUtc <= hrUtc) return { ok:true, mode:'hr', cutoffUtc:cutoffUtc.toISOString(), hrCutoffUtc:hrUtc.toISOString() };
  }
  return { ok:false, reason:'deadline passed', cutoffUtc:cutoffUtc.toISOString() };
}

module.exports = async (req,res)=>{
  try{
    if (req.method==='OPTIONS') return json(res,200,{ok:true});
    if (req.method!=='POST') return json(res,405,{error:'POST only'});
    if (!BASE || !APIKEY) return json(res,500,{error:'Missing AIRTABLE_* env'});

    const body = await readBody(req);
    const { employeeID, org, token, orderId, date, included, boxes, extras, hardDelete } = body||{};
    if (!employeeID || !org || !token || !orderId) return json(res,400,{error:'employeeID, org, token, orderId required'});

    // 1) requester
    const er = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS, F.EMP_ROLE],
      maxRecords: 1
    });
    const requester = one(er.records); if (!requester) return json(res,404,{error:'employee not found'});
    const ef = requester.fields||{};
    const reqOrg = (Array.isArray(ef[F.EMP_ORG_LOOKUP])? ef[F.EMP_ORG_LOOKUP][0]: ef[F.EMP_ORG_LOOKUP]) || null;
    if (reqOrg !== org) return json(res,403,{error:'org mismatch'});
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) return json(res,403,{error:'invalid token'});
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase()!=='active') return json(res,403,{error:'employee not active'});
    const role = String(ef[F.EMP_ROLE]||'').toUpperCase();
    const isHRorManager = role.includes('HR') || role.includes('MANAGER');

    // 2) order
    const or = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      'fields[]': ['Order Date','Order Type', F.ORDER_EMPLOYEE, F.ORDER_MB_LINK, F.ORDER_OL_LINK],
      maxRecords: 1
    });
    const ord = one(or.records); if (!ord) return json(res,404,{error:'order not found'});

    // owner org check (через владельца заказа)
    const ownerId = ord.fields?.[F.ORDER_EMPLOYEE]?.[0];
    if (!ownerId) return json(res,400,{error:'order has no owner employee'});
    const owner = one((await atGet(TABLE.EMPLOYEES, { filterByFormula:`RECORD_ID()='${ownerId}'`, 'fields[]':[F.EMP_ORG_LOOKUP], maxRecords:1 })).records);
    const ownerOrg = (Array.isArray(owner?.fields?.[F.EMP_ORG_LOOKUP])? owner.fields[F.EMP_ORG_LOOKUP][0]: owner?.fields?.[F.EMP_ORG_LOOKUP]) || null;
    if (ownerOrg !== org) return json(res,403,{error:'order belongs to another org'});

    // permission: self or HR/Manager
    if (ownerId !== employeeID && !isHRorManager) return json(res,403,{error:'not allowed to update others order'});

    // 3) cutoff window
    const deliveryDate = date || String(ord.fields['Order Date']).substring(0,10);
    const orgRec = await getOrgByCode(org); if (!orgRec) return json(res,400,{error:'organization not found'});
    const win = canOrderNow(new Date(), deliveryDate, orgRec, isHRorManager);
    if (!win.ok) return json(res,403,{error:win.reason, cutoffUtc:win.cutoffUtc, hrCutoffUtc:win.hrCutoffUtc});

    // 4) unlink current children
    const currentMB = ord.fields?.[F.ORDER_MB_LINK] || [];
    const currentOL = ord.fields?.[F.ORDER_OL_LINK] || [];
    await atPatch(TABLE.ORDERS, { typecast:true, records:[{ id: orderId, fields: { [F.ORDER_MB_LINK]: [], [F.ORDER_OL_LINK]: [] } }] });

    // optional hard delete
    const deleteLog = {};
    if (hardDelete === true) {
      if (currentMB.length) { await atDelete(TABLE.MEALBOXES, currentMB); deleteLog.mealBoxes = currentMB.length; }
      if (currentOL.length) { await atDelete(TABLE.ORDERLINES, currentOL); deleteLog.orderLines = currentOL.length; }
    }

    // 5) rebuild children based on payload
    const ids = { mealBoxes:[], orderLines:[] };
    const orderType = String(ord.fields['Order Type']||'Employee');

    // A) Employee-style (included)
    if (included && (included.mainId || included.sideId || Array.isArray(included.extras))) {
      // meal box 1×
      if (included.mainId || included.sideId) {
        const mb = await atPost(TABLE.MEALBOXES, {
          typecast:true,
          records:[{ fields:{
            [F.MB_ORDER]: [orderId],
            [F.MB_QTY]: 1,
            [F.MB_TYPE]:'Included',
            ...(included.mainId? { [F.MB_MAIN]: [included.mainId] } : {}),
            ...(included.sideId? { [F.MB_SIDE]: [included.sideId] } : {}),
          }}]
        });
        (mb.records||[]).forEach(r=>ids.mealBoxes.push(r.id));
      }
      // extras (до 2 шт., если надо — увеличим)
      const ex = Array.isArray(included.extras) ? included.extras : [];
      if (ex.length){
        const recs = ex.slice(0,2).map(id=>({ fields:{
          [F.OL_ORDER]: [orderId],
          [F.OL_ITEM]:  [id],
          [F.OL_QTY]:   1,
          [F.OL_TYPE]: 'Included'
        }}));
        const ol = await atPost(TABLE.ORDERLINES, { typecast:true, records: recs });
        (ol.records||[]).forEach(r=>ids.orderLines.push(r.id));
      }
    }

    // B) Manager-style (boxes + extras[] с qty)
    if (Array.isArray(boxes) && boxes.length){
      const mbRecs = boxes.map(b=>{
        const qtyStd = Math.max(0, +b.qtyStandard||0);
        const qtyUps = Math.max(0, +b.qtyUpsized||0);
        const qty = qtyStd + qtyUps;
        return { fields:{
          [F.MB_ORDER]: [orderId],
          [F.MB_QTY]: qty,
          [F.MB_TYPE]:'Included',
          ...(b.mainId? { [F.MB_MAIN]: [b.mainId] } : {}),
          ...(b.sideId? { [F.MB_SIDE]: [b.sideId] } : {}),
        }};
      });
      if (mbRecs.length){
        const mb = await atPost(TABLE.MEALBOXES, { typecast:true, records: mbRecs });
        (mb.records||[]).forEach(r=>ids.mealBoxes.push(r.id));
      }
    }
    if (Array.isArray(extras) && extras.length){
      const olRecs = extras
        .filter(x=>x?.itemId && +x?.qty>0)
        .map(x=>({ fields:{
          [F.OL_ORDER]: [orderId],
          [F.OL_ITEM]:  [x.itemId],
          [F.OL_QTY]:   +x.qty,
          [F.OL_TYPE]: 'Included'
        }}));
      if (olRecs.length){
        const ol = await atPost(TABLE.ORDERLINES, { typecast:true, records: olRecs });
        (ol.records||[]).forEach(r=>ids.orderLines.push(r.id));
      }
    }

    // 6) patch back-links
    const patchFields = {};
    if (ids.mealBoxes.length)  patchFields[F.ORDER_MB_LINK] = ids.mealBoxes;
    if (ids.orderLines.length) patchFields[F.ORDER_OL_LINK] = ids.orderLines;
    if (Object.keys(patchFields).length) {
      await atPatch(TABLE.ORDERS, { typecast:true, records:[{ id: orderId, fields: patchFields }] });
    }

    return json(res,200,{
      ok:true,
      orderId,
      orderType,
      rebuilt: { mealBoxes: ids.mealBoxes.length, orderLines: ids.orderLines.length },
      hardDelete: hardDelete===true ? deleteLog : undefined
    });

  }catch(e){
    console.error('order_update failed:', e);
    return json(res,500,{ error: e.message || String(e) });
  }
};
