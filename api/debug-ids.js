// api/debug-ids.js
import { aGet, cors, fstr, T } from './_lib/air.js';

function buildOrByIds(ids){
  const parts = ids.map(id => `RECORD_ID()='${fstr(id)}'`);
  return parts.length ? `OR(${parts.join(',')})` : "FALSE()";
}

export default async function handler(req, res){
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try{
    const { ol, mb } = req.query; // строки вида "recA,recB"
    const olIds = typeof ol === 'string' && ol.trim() ? ol.split(',').map(s=>s.trim()) : [];
    const mbIds = typeof mb === 'string' && mb.trim() ? mb.split(',').map(s=>s.trim()) : [];

    const out = { ok:true, orderLines:[], mealBoxes:[] };

    if (olIds.length){
      const r = await aGet(T.orderlines, {
        filterByFormula: buildOrByIds(olIds),
        'fields[]': ['Order','Item (Menu Item)','Quantity','Line Type']
      });
      out.orderLines = (r.records||[]).map(x=>({ id:x.id, fields:x.fields }));
    }

    if (mbIds.length){
      const r = await aGet(T.mealboxes, {
        filterByFormula: buildOrByIds(mbIds),
        'fields[]': ['Order','Main (Menu Item)','Side (Menu Item)','Quantity','Line Type']
      });
      out.mealBoxes = (r.records||[]).map(x=>({ id:x.id, fields:x.fields }));
    }

    res.status(200).json(out);
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
}
