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

export function fstr(s=''){ return String(s).replace(/'/g, "''"); }

export async function aGet(table, params={}){
  const url = new URL(`${API}/${encodeURIComponent(table)}`);
  for (const [k,v] of Object.entries(params)){
    if (Array.isArray(v)) {
      const keyName = k === 'fields' ? 'fields[]' : k;   // поддержка массивов полей
      v.forEach(val => url.searchParams.append(keyName, val));
      }
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: HDRS });
  if (!r.ok) throw new Error(`GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function aCreate(table, records){
  const r = await fetch(`${API}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: HDRS,
    body: JSON.stringify({ records: records.map(f=>({ fields: f })), typecast: true })
  });
  if (!r.ok) throw new Error(`CREATE ${table}: ${r.status} ${await r.text()}`);
  return r.json();
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
}
  export async function aUpdate(table, records){
  const r = await fetch(`${API}/${encodeURIComponent(table)}`, {
    method: 'PATCH',
    headers: HDRS,
    body: JSON.stringify({ records, typecast: true })
  });
  if (!r.ok) throw new Error(`UPDATE ${table}: ${r.status} ${await r.text()}`);
  return r.json();
};
