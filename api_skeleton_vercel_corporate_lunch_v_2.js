// ===============================
// File: vercel.json
// ===============================
{
  "version": 2,
  "builds": [{ "src": "api/**/*.js", "use": "@vercel/node" }]
}

// ===============================
// File: package.json
// ===============================
{
  "name": "corporate-lunch-api",
  "private": true,
  "type": "module",
  "dependencies": {}
}

// ===============================
// File: api/_lib/air.js
// ===============================
const BASE = process.env.AIRTABLE_BASE_ID;
const KEY  = process.env.AIRTABLE_API_KEY;

const API = `https://api.airtable.com/v0/${BASE}`;
const HDRS = {
  'Authorization': `Bearer ${KEY}`,
  'Content-Type': 'application/json'
};

export function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

export function fstr(s=''){
  // Формат строк для filterByFormula — одиночные кавычки удваиваем
  return String(s).replace(/'/g, "''");
}

export async function aGet(table, params={}){
  const url = new URL(`${API}/${encodeURIComponent(table)}`);
  for (const [k,v] of Object.entries(params)){
    if (Array.isArray(v)) v.forEach(val=> url.searchParams.append(k, val));
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: HDRS });
  if (!r.ok) throw new Error(`GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function aCreate(table, records){
  const r = await fetch(`${API}/${encodeURIComponent(table)}` ,{
    method: 'POST',
    headers: HDRS,
    body: JSON.stringify({ records: records.map(f=>({ fields: f })), typecast: true })
  });
  if (!r.ok) throw new Error(`CREATE ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function aListAll(table, params={}){
  let offset; const all=[]; do{
    const js = await aGet(table, { ...params, offset });
    all.push(...(js.records||[]));
    offset = js.offset;
  } while (offset);
  return all;
}

export async function aFindOne(table, filterByFormula){
  const js = await aGet(table, { maxRecords: '1', filterByFormula });
  return js.records?.[0] || null;
}

export const T = {
  menu: process.env.MENU_TABLE || 'Menu',
  employees: process.env.EMPLOYEES_TABLE || 'Employees',
  orders: process.env.ORDERS_TABLE || 'Orders',
  mealboxes: process.env.MEALBOXES_TABLE || 'Meal Boxes',
  orderlines: process.env.ORDERLINES_TABLE || 'Order Lines',
  orgs: process.env.ORGS_TABLE || 'Organizations'
};

// ===============================
// File: api/health.js
// ===============================
import { cors } from './_lib/air.js';
export default (req,res)=>{ cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;} res.status(200).json({ ok:true, time:new Date().toISOString() }); };

// ===============================
// File: api/dates.js
// ===============================
import { aGet, aFindOne, T, fstr, cors } from './_lib/air.js';

export default async function handler(req,res){
  cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;}
  try{
    const { employeeID, org } = req.query;
    if(!employeeID||!org) return res.status(400).json({error:'employeeID & org required'});

    // 1) Проверка сотрудника (Active, org, token не проверяем здесь)
    const emp = await aFindOne(T.employees,
      `AND(RECORD_ID()='${fstr(employeeID)}', {OrgID}='${fstr(org)}', {Status}='Active')`);
    if(!emp) return res.status(403).json({ error:'employee not allowed' });

    // 2) Даты меню: Published=✓, в окне [сегодня..+7], доступ ALL или содержит org
    const filterDates = `AND(
      {Published}=1,
      IS_AFTER({Date}, DATEADD(TODAY(), -1, 'days')),
      IS_BEFORE({Date}, DATEADD(TODAY(), 8, 'days')),
      OR({AccessLine}='ALL', FIND('${fstr(org)}', {AccessLine}))
    )`;
    const dj = await aGet(T.menu, {
      filterByFormula: filterDates,
      'sort[0][field]':'Date','sort[0][direction]':'asc',
      fields: ['Date']
    });

    // 3) Заказы сотрудника в окне (для флага hasOrder)
    const filterOrders = `AND(
      {Employee}='${fstr(employeeID)}', {Status}!='Cancelled',
      IS_AFTER({Order Date}, DATEADD(TODAY(), -1, 'days')),
      IS_BEFORE({Order Date}, DATEADD(TODAY(), 8, 'days'))
    )`;
    const oj = await aGet(T.orders, { filterByFormula: filterOrders, fields: ['Order Date'] });
    const have = new Set((oj.records||[]).map(r=>r.fields['Order Date']));

    const dates = (dj.records||[]).map(r=>({ id:r.id, date:r.fields.Date, hasOrder: have.has(r.fields.Date) }));
    res.status(200).json({ dates });
  }catch(e){ res.status(500).json({ error: e.message }); }
}

// ===============================
// File: api/menu.js
// ===============================
import { aGet, T, fstr, cors } from './_lib/air.js';

function push(map, key, val){ (map[key]||(map[key]=[])).push(val); }

export default async function handler(req,res){
  cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;}
  try{
    const { date, org } = req.query;
    if(!date||!org) return res.status(400).json({error:'date & org required'});

    const filter = `AND(
      {Published}=1,
      {Date}='${fstr(date)}',
      OR({AccessLine}='ALL', FIND('${fstr(org)}', {AccessLine}))
    )`;

    const fields = [
      'Price','Category',
      'Dish Name (from Dish)','Description (from Dish)','Ingredients (from Dish)',
      'Garnirnoe (from Dish)'
    ];

    const js = await aGet(T.menu, { filterByFormula: filter, maxRecords:'500', fields });

    const buckets = {};
    for (const r of (js.records||[])){
      const f = r.fields;
      const item = {
        id: r.id,
        name: f['Dish Name (from Dish)'] || '',
        price: Number(f.Price || 0),
        garnirnoe: !!f['Garnirnoe (from Dish)'],
        description: f['Description (from Dish)'] || '',
        ingredients: f['Ingredients (from Dish)'] || ''
      };
      push(buckets, (f.Category||'Other'), item);
    }

    res.status(200).json({
      mains: buckets['Main']||[],
      sides: buckets['Side']||[],
      soups: buckets['Soup']||[],
      salads: buckets['Salad']||[],
      drinks: buckets['Drink']||[],
      bliny: buckets['Bliny']||[],
      zapekanka: buckets['Zapekanka']||[],
      pastry: buckets['Pastry']||[],
      fruit: buckets['Fruit']||[]
    });
  }catch(e){ res.status(500).json({ error:e.message }); }
}

// ===============================
// File: api/order.js
// ===============================
import { aFindOne, aCreate, aGet, T, fstr, cors } from './_lib/air.js';

async function employeeAllowed(employeeID, org, token){
  const emp = await aFindOne(T.employees,
    `AND(RECORD_ID()='${fstr(employeeID)}', {OrgID}='${fstr(org)}', {Status}='Active', {Order Token}='${fstr(token)}')`);
  return emp;
}

export default async function handler(req,res){
  cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;}
  try{
    if(req.method!=='POST') return res.status(405).json({error:'POST only'});
    const { employeeID, org, token, date, included } = req.body||{};
    if(!employeeID||!org||!token||!date||!included) return res.status(400).json({error:'missing fields'});

    // 1) Верификация сотрудника
    const emp = await employeeAllowed(employeeID, org, token);
    if(!emp) return res.status(403).json({error:'employee not allowed'});

    // 2) Проверка: дата доступна (Published+AccessLine)
    const menuDate = await aFindOne(T.menu, `AND({Published}=1, {Date}='${fstr(date)}', OR({AccessLine}='ALL', FIND('${fstr(org)}',{AccessLine})))`);
    if(!menuDate) return res.status(400).json({error:'date is not available for this org'});

    // 3) Анти‑дубль
    const dup = await aFindOne(T.orders,
      `AND({Employee}='${fstr(employeeID)}', {Order Date}='${fstr(date)}', {Status}!='Cancelled')`);
    if(dup) return res.status(200).json({ ok:true, duplicate:true, orderId: dup.id });

    // 4) Создаём Order
    const o = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': { name: 'Employee' },
      'Status': { name: 'New' },
      'Employee': [{ id: employeeID }]
    }]);
    const orderId = o.records[0].id;

    // 5) Included extras (до 2)
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0,2) : [];
    if (extras.length){
      const ol = extras.map(id=>({
        'Order': [{ id: orderId }],
        'Item (Menu Item)': [{ id }],
        'Quantity': 1,
        'Line Type': { name: 'Included' }
      }));
      await aCreate(T.orderlines, ol);
    }

    // 6) Meal Box (main+side)
    if(!included.mainId) return res.status(400).json({error:'mainId required'});
    const mb = {
      'Order': [{ id: orderId }],
      'Main (Menu Item)': [{ id: included.mainId }],
      'Quantity': 1,
      'Line Type': { name: 'Included' },
      'Packaging': { name: 'В одном' }
    };
    if (included.sideId) mb['Side (Menu Item)'] = [{ id: included.sideId }];
    await aCreate(T.mealboxes, [mb]);

    res.status(200).json({ ok:true, orderId });
  }catch(e){ res.status(500).json({ error:e.message }); }
}

// ===============================
// (Черновик) File: api/hr/orders.js — на будущее
// ===============================
// TODO: список заказов HR по org/date + правки/удаления до cut-off
