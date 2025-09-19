// api/debug-order.js
import { aGet, cors, fstr, T } from './_lib/air.js';

export default async function handler(req, res){
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  // Фильтруем по ссылочному полю: ищем id заказа в ARRAYJOIN({Order})
  const filter = (id) => `FIND('${fstr(id)}', ARRAYJOIN({Order}&''))>0`;

  try{
    const ol = await aGet(T.orderlines, {
      filterByFormula: filter(orderId),
      'fields[]': ['Order','Item (Menu Item)','Quantity','Line Type']
    });
    const mb = await aGet(T.mealboxes, {
      filterByFormula: filter(orderId),
      'fields[]': ['Order','Main (Menu Item)','Side (Menu Item)','Quantity','Line Type']
    });

    res.status(200).json({
      ok: true,
      orderId,
      orderLines: ol.records?.map(r => ({ id: r.id, fields: r.fields })) || [],
      mealBoxes: mb.records?.map(r => ({ id: r.id, fields: r.fields })) || []
    });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
}
