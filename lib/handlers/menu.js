// /lib/handlers/menu.js
// GET /api/menu?date=YYYY-MM-DD&org=org120
// Ответ: { ok:true, date, org, items:[{ id, name, description, category, price?, garnirnoe?, ingredients? }] }

const { json, withRateLimit, atGet, listAll, TABLE } = require('../../lib/utils');

// утилиты чтения из lookup/массивов
const first = v => (Array.isArray(v) ? v[0] : v);
const bool  = v => (Array.isArray(v) ? !!v[0] : !!v);

// нормализация категорий к кодам, которые понимает фронт
const CAT_MAP = new Map([
  ['Main','Main'], ['Side','Side'],
  ['Soup','Soups'], ['Soups','Soups'], ['Суп','Soups'],
  ['Salad','Salads'], ['Salads','Salads'], ['Салат','Salads'],
  ['Bliny','Pancakes'], ['Блины','Pancakes'],
  ['Zapekanka','Casseroles'], ['Запеканка','Casseroles'],
  ['Pastry','Bakery'], ['Выпечка','Bakery'],
  ['Drink','Drinks'], ['Напиток','Drinks'],
  ['Fruit','Fruit'],
]);
const normCat = v => CAT_MAP.get(String(first(v) || '').trim()) || 'Other';

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const url  = new URL(req.url, `http://${req.headers.host}`);
    const date = url.searchParams.get('date');
    const org  = url.searchParams.get('org');
    if (!date || !org) return json(res, 400, { ok:false, error:'date & org required' });

    // Published + конкретная дата + доступ по AccessLine
    const filter = `
      AND(
        {Published}=1,
        IS_SAME({Date}, DATETIME_PARSE('${date}'), 'day'),
        OR({AccessLine}='ALL', FIND('${org}', {AccessLine}))
      )`;

    const fields = [
      'Price',
      'Category',
      'Dish Name (from Dish)',
      'Description (from Dish)',
      'Ingredients (from Dish)',
      'Garnirnoe (from Dish)'
    ];

    // Airtable max pageSize = 100 — используем наш listAll для пагинации
    const records = await listAll(TABLE.MENU, {
      filterByFormula: filter,
      "fields[]": fields,
      pageSize: 100,
      "sort[0][field]": "Category"
    });

    const items = (records || []).map(rec => {
      const f = rec.fields || {};
      return {
        id: rec.id,
        name: first(f['Dish Name (from Dish)']) || '',
        description: first(f['Description (from Dish)']) || '',
        category: normCat(f['Category']),
        price: Number(f.Price || 0),
        garnirnoe: bool(f['Garnirnoe (from Dish)']),
        ingredients: first(f['Ingredients (from Dish)']) || ''
      };
    });

    return json(res, 200, { ok: true, date, org, items });
  } catch (e) {
    return json(res, 500, { ok:false, error: e.message || String(e) });
  }
}, { windowMs: 4000, max: 30 });
