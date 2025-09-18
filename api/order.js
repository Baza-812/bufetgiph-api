import { aFindOne, aCreate, aGet, T, fstr, cors } from './_lib/air.js';

async function employeeAllowed(employeeID, org, token){
  const emp = await aFindOne(T.employees,
  `AND(
    RECORD_ID()='${fstr(employeeID)}',
    {Status}='Active',
    {Order Token}='${fstr(token)}',
    FIND('${fstr(org)}', {OrgID (from Organization)}) > 0
  )`);
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

    // 2) Дата доступна (Published+AccessLine)
    const menuDate = await aFindOne(T.menu, `AND({Published}=1, {Date}='${fstr(date)}', OR({AccessLine}='ALL', FIND('${fstr(org)}',{AccessLine})))`);
    if(!menuDate) return res.status(400).json({error:'date is not available for this org'});

    // 3) Анти-дубль
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
