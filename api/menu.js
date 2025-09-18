import { aGet, T, fstr, cors } from './_lib/air.js';

const first = v => Array.isArray(v) ? v[0] : v;    // забираем 1-е значение из lookup
const bool  = v => Array.isArray(v) ? !!v[0] : !!v;

function push(map, key, val){ (map[key]||(map[key]=[])).push(val); }

export default async function handler(req,res){
  cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;}
  try{
    const { date, org } = req.query;
    if(!date||!org) return res.status(400).json({error:'date & org required'});

    // сравниваем дату по дню (а не строковым равенством)
    const filter = `AND(
      {Published}=1,
      IS_SAME({Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
      OR({AccessLine}='ALL', FIND('${fstr(org)}', {AccessLine}))
    )`;

    const fields = [
      'Price','Category',
      'Dish Name (from Dish)','Description (from Dish)','Ingredients (from Dish)',
      'Garnirnoe (from Dish)'
    ];

    const js = await aGet(T.menu, {
      filterByFormula: filter,
      maxRecords: '500',
      'fields[]': fields,
      'sort[0][field]': 'Category'
    });

    const buckets = {};
    for (const r of (js.records||[])){
      const f = r.fields;
      const item = {
        id: r.id,
        name: first(f['Dish Name (from Dish)']) || '',
        price: Number(f.Price || 0),
        garnirnoe: bool(f['Garnirnoe (from Dish)']),
        description: first(f['Description (from Dish)']) || '',
        ingredients: first(f['Ingredients (from Dish)']) || ''
      };
      const cat = first(f.Category) || 'Other';
      push(buckets, cat, item);
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
