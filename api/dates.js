import { aGet, aFindOne, T, fstr, cors } from './_lib/air.js';

export default async function handler(req,res){
  cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;}
  try{
    const { employeeID, org } = req.query;
    if(!employeeID||!org) return res.status(400).json({error:'employeeID & org required'});

    // сотрудник активен и принадлежит org
    const emp = await aFindOne(T.employees,
  `AND(
    RECORD_ID()='${fstr(employeeID)}',
    {Status}='Active',
    FIND('${fstr(org)}', {OrgID (from Organization)}) > 0
  )`);
    if(!emp) return res.status(403).json({ error:'employee not allowed' });

    // Published меню на 7 дней вперёд, доступно для org
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

    // Заказы сотрудника на эти даты
    const filterOrders = `AND(
      {Employee}='${fstr(employeeID)}', {Status}!='Cancelled',
      IS_AFTER({Order Date}, DATEADD(TODAY(), -1, 'days')),
      IS_BEFORE({Order Date}, DATEADD(TODAY(), 8, 'days'))
    )`;
    const oj = await aGet(T.orders, { filterByFormula: filterOrders, fields: ['Order Date'] });
    const have = new Set((oj.records||[]).map(r=>r.fields['Order Date']));

    const perDate = new Map();
for (const r of (dj.records||[])) {
  const d = r.fields.Date;
  if (!d) continue;
  // берём первый встретившийся id, он нам не принципиален
  if (!perDate.has(d)) perDate.set(d, { id: r.id, date: d });
}

const dates = Array.from(perDate.values()).map(x => ({
  ...x,
  hasOrder: have.has(x.date)
}));

res.status(200).json({ dates });
  }catch(e){ res.status(500).json({ error: e.message }); }
}
