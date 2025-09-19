// api/_lib/air.js

// --- ENV ---
const AIRTABLE_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || process.env.AIRTABLE_BASE_ID;

if (!AIRTABLE_KEY || !AIRTABLE_BASE) {
  console.warn('[air.js] Missing AIRTABLE_API_KEY or AIRTABLE_BASE env vars');
}

// --- Таблицы (единые имена по базе) ---
export const T = {
  employees:   'Employees',
  organizations: 'Organizations',
  menu:        'Menu',          // расписание меню на даты
  orders:      'Orders',
  orderlines:  'Order Lines',
  mealboxes:   'Meal Boxes',
};

// --- Утилиты ---
function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item) => qs.append(k, String(item)));
    } else {
      qs.append(k, String(v));
    }
  }
  return qs.toString();
}

// безопасная строка для формул Airtable (экраним одиночные кавычки)
export function fstr(s = '') {
  return String(s).replace(/'/g, "\\'");
}

// простые CORS заголовки для API
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Базовый fetch к Airtable
async function airRequest(method, table, { query, body, label } = {}) {
  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const url = query ? `${baseUrl}?${buildQuery(query)}` : baseUrl;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const prefix = label ? `${label} ${table}` : `${method} ${table}`;
    throw new Error(`${prefix}: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// --- Публичные хелперы ---

// GET с query-параметрами (fields[], filterByFormula, maxRecords и т.д.)
export async function aGet(table, params = {}) {
  return airRequest('GET', table, { query: params, label: 'GET' });
}

// Создание записей (всегда с typecast:true для ссылок/селектов)
export async function aCreate(table, records) {
  const body = { records, typecast: true };
  return airRequest('POST', table, { body, label: 'CREATE' });
}

// Обновление записей (всегда с typecast:true)
export async function aUpdate(table, records) {
  const body = { records, typecast: true };
  return airRequest('PATCH', table, { body, label: 'UPDATE' });
}

// Найти один (первый) по формуле; вернёт объект записи или null
export async function aFindOne(table, filterFormula) {
  const resp = await aGet(table, {
    filterByFormula: filterFormula,
    maxRecords: 1,
    pageSize: 1,
  });
  return resp.records && resp.records.length ? resp.records[0] : null;
}
