// lib/handlers/menu.js
const { atGet, json, F, TABLE } = require('../../lib/utils');

const first = v => Array.isArray(v) ? v[0] : v;
const asBool = v => {
  // поддержка формулы 1/0 и lookup-значения
  if (v === 1 || v === '1' || v === true) return true;
  if (v === 0 || v === '0' || v === false || v == null) return false;
  if (Array.isArray(v)) return v.length > 0 && !!v[0];
  return !!v;
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { ok: false, error: 'GET only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const date = url.searchParams.get('date');
    const org  = url.searchParams.get('org');
    if (!date || !org) return json(res, 400, { ok:false, error: 'date & org required' });

    // Published + дата по дню + доступ org
    const filter = `
      AND(
        {Published}=1,
        IS_SAME({Date}, DATETIME_PARSE('${date}'), 'day'),
        OR({AccessLine}='ALL', FIND('${org}', {AccessLine}))
      )`;

    const fields = [
      'Price','Category',
      'Dish Name (from Dish)','Description (from Dish)','Ingredients (from Dish)',
      'Garnirnoe (from Dish)',           // lookup
      'Garnirnoe Bool'                   // формула 1/0
    ];

    const resp = await atGet(TABLE.MENU, {
      filterByFormula: filter,
      pageSize: 100,
      'fields[]': fields,
      'sort[0][field]': 'Category'
    });

    const items = (resp.records || []).map(r => {
      const f = r.fields || {};
      const garnirFromBool   = f['Garnirnoe Bool'];
      const garnirFromLookup = f['Garnirnoe (from Dish)'];
      return {
        id: r.id,
        name: first(f['Dish Name (from Dish)']) || '',
        description: first(f['Description (from Dish)']) || '',
        ingredients: first(f['Ingredients (from Dish)']) || '',
        category: first(f['Category']) || 'Other',
        price: Number(f['Price'] || 0),
        // приоритет у формулы 1/0; если её нет — используем lookup
        garnirnoe: asBool(garnirFromBool != null ? Number(garnirFromBool) : garnirFromLookup)
      };
    });

    return json(res, 200, { ok: true, date, org, items });
  } catch (e) {
    return json(res, 500, { ok:false, error: e.message || String(e) });
  }
};
