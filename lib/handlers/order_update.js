// api/order_update.js — Update existing order (with Starshiy program support)

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:     env('TBL_ORDERS',     'Orders'),
  EMPLOYEES:  env('TBL_EMPLOYEES',  'Employees'),
  MEALBOXES:  env('TBL_MEALBOXES',  'Meal Boxes'),
  ORDERLINES: env('TBL_ORDERLINES', 'Order Lines'),
  ORGS:       env('TBL_ORGS',       'Organizations'),
};

const F = {
  // Employees
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),
  EMP_ROLE:       env('FLD_EMP_ROLE',       'Role'),

  // Orders
  ORDER_EMPLOYEE:         env('FLD_ORDER_EMPLOYEE',         'Employee'),
  ORDER_MB_LINK:          env('FLD_ORDER_MB_LINK',          'Meal Boxes'),
  ORDER_OL_LINK:          env('FLD_ORDER_OL_LINK',          'Order Lines'),
  ORDER_STATUS:           env('FLD_ORDER_STATUS',           'Status'),
  ORDER_TARIFF_CODE:      env('FLD_ORDER_TARIFF_CODE',      'TariffCode'),
  ORDER_EMPLOYEE_PAYABLE: env('FLD_ORDER_EMPLOYEE_PAYABLE', 'EmployeePayableAmount'),

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
  ORG_ID:          env('FLD_ORG_ID',          'OrgID'),
  ORG_VID_DOGOVORA: env('FLD_ORG_VID_DOGOVORA', 'VidDogovora'),
  ORG_PRICE_FULL:  env('FLD_ORG_PRICE_FULL',  'PriceFull'),
  ORG_PRICE_LIGHT: env('FLD_ORG_PRICE_LIGHT', 'PriceLight'),
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
    if (Array.isArray(v)) v.forEach(vv=>usp.append(k,vv));
    else if (v!=null) usp.append(k,v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPost(t, body) {
  const r = await fetch(atUrl(t), { method:'POST', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT POST ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPatch(t, body) {
  const r = await fetch(atUrl(t), { method:'PATCH', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atDelete(t, ids) {
  const usp = new URLSearchParams();
  ids.forEach(id => usp.append('records[]', id));
  const r = await fetch(`${atUrl(t)}?${usp}`, { method:'DELETE', headers:atHeaders() });
  if (!r.ok) throw new Error(`AT DELETE ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a)=> (Array.isArray(a)&&a.length?a[0]:null);

async function readBody(req){
  if (req.body && typeof req.body==='object') return req.body;
  if (typeof req.body==='string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(res=>{
    let d=''; req.on('data',c=>d+=c); req.on('end',()=>{
      try{res(d?JSON.parse(d):{});}catch{res({});}
    });
  });
}

module.exports = async (req,res)=>{
  try{
    if (req.method==='OPTIONS') return json(res,200,{ok:true});
    if (req.method!=='POST') return json(res,405,{error:'POST only'});

    if (!BASE || !APIKEY) return json(res,500,{error:'Missing AIRTABLE_* env'});

    const body = await readBody(req);
    const { employeeID, org, token, orderId, included, forEmployeeID, tariffCode } = body||{};

    if (!employeeID || !org || !token || !orderId) {
      return json(res,400,{error:'employeeID, org, token, orderId required'});
    }

    // Проверка сотрудника (requester)
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
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase()!=='active') {
      return json(res,403,{error:'employee not active'});
    }

    const isHR = String(ef[F.EMP_ROLE]||'').toUpperCase().includes('HR');
    const role = ef[F.EMP_ROLE] || 'Employee';

    // Получаем заказ
    const orderResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      maxRecords: 1,
      'fields[]': [
        F.ORDER_EMPLOYEE,
        F.ORDER_MB_LINK,
        F.ORDER_OL_LINK,
        F.ORDER_STATUS,
        F.ORDER_TARIFF_CODE,
        F.ORDER_EMPLOYEE_PAYABLE,
      ],
    });

    const orderRec = one(orderResp.records);
    if (!orderRec) return json(res,404,{error:'order not found'});

    const of = orderRec.fields || {};
    const orderEmployees = of[F.ORDER_EMPLOYEE] || [];
    const orderStatus = of[F.ORDER_STATUS] || 'New';

    // Проверка прав: либо свой заказ, либо HR может редактировать за других
    let targetEmpId = employeeID;
    if (forEmployeeID && forEmployeeID !== employeeID) {
      if (!isHR) return json(res,403,{error:'only HR can update on behalf'});
      targetEmpId = forEmployeeID;
    }

    const isOwner = Array.isArray(orderEmployees) && orderEmployees.includes(targetEmpId);
    if (!isOwner && !isHR) {
      return json(res,403,{error:'not authorized to update this order'});
    }

    // Получаем организацию (для пересчёта цены, если нужно)
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      maxRecords: 1,
      'fields[]': [F.ORG_VID_DOGOVORA, F.ORG_PRICE_FULL, F.ORG_PRICE_LIGHT],
    });

    const orgRec = one(orgResp.records);
    if (!orgRec) return json(res,400,{error:'organization not found'});

    const orgFields = orgRec.fields || {};
    const vidDogovora = orgFields[F.ORG_VID_DOGOVORA] || 'Contract';
    const priceFull = orgFields[F.ORG_PRICE_FULL] || null;
    const priceLight = orgFields[F.ORG_PRICE_LIGHT] || null;

    // Удаляем старые Meal Boxes и Order Lines
    const oldMBs = of[F.ORDER_MB_LINK] || [];
    const oldOLs = of[F.ORDER_OL_LINK] || [];

    if (oldMBs.length) await atDelete(TABLE.MEALBOXES, oldMBs);
    if (oldOLs.length) await atDelete(TABLE.ORDERLINES, oldOLs);

    // Создаём новые Meal Boxes и Order Lines
    const ids = { mealBoxes:[], orderLines:[] };

    if (included?.mainId || included?.sideId){
      const mbFields = { [F.MB_ORDER]:[orderId], [F.MB_QTY]:1, [F.MB_TYPE]:'Included' };
      if (included.mainId) mbFields[F.MB_MAIN] = [included.mainId];
      if (included.sideId) mbFields[F.MB_SIDE] = [included.sideId];

      const mbResp = await atPost(TABLE.MEALBOXES,{ typecast:true, records:[{ fields: mbFields }]});
      (mbResp.records||[]).forEach(r=>ids.mealBoxes.push(r.id));
    }

    const extras = Array.isArray(included?.extras) ? included.extras.slice(0,2) : [];
    if (extras.length){
      const olResp = await atPost(TABLE.ORDERLINES,{
        typecast:true,
        records: extras.map(itemId => ({
          fields:{ [F.OL_ORDER]:[orderId], [F.OL_ITEM]:[itemId], [F.OL_QTY]:1, [F.OL_TYPE]:'Included' }
        }))
      });
      (olResp.records||[]).forEach(r=>ids.orderLines.push(r.id));
    }

    // Обновляем заказ: back-links + tariffCode + пересчёт цены (если программа Старший)
    const patchFields = {};
    if (ids.mealBoxes.length) patchFields[F.ORDER_MB_LINK] = ids.mealBoxes;
    if (ids.orderLines.length) patchFields[F.ORDER_OL_LINK] = ids.orderLines;

    // Если передан tariffCode и это программа Старший + роль Komanda — пересчитываем цену
    if (tariffCode && vidDogovora === 'Starshiy' && role === 'Komanda') {
      patchFields[F.ORDER_TARIFF_CODE] = tariffCode;
      const newPrice = tariffCode === 'Light' ? priceLight : priceFull;
      if (newPrice !== null) {
        patchFields[F.ORDER_EMPLOYEE_PAYABLE] = newPrice;
      }
    }

    if (Object.keys(patchFields).length) {
      await atPatch(TABLE.ORDERS,{ typecast:true, records:[{ id:orderId, fields:patchFields }]});
    }

    return json(res,200,{
      ok:true,
      orderId,
      updated: true,
      ids,
    });

  }catch(e){
    console.error('order_update.js failed:', e);
    return json(res,500,{ error: e.message || String(e) });
  }
};
