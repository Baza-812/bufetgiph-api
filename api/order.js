// api/order.js
import { aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

// --- CONFIG: имена полей (можно переопределить через ENV) ---
// В Orders (родитель): как называются обратные линк-поля
const ORDER_MB_LINK_FIELD = process.env.ORDER_MB_LINK_FIELD || 'Meal Boxes';
const ORDER_OL_LINK_FIELD = process.env.ORDER_OL_LINK_FIELD || 'Order Lines';

// В Meal Boxes (дочерняя): как называются поля
const MB_ORDER_FIELD = process.env.MB_ORDER_FIELD || 'Order';
const MB_MAIN_FIELD  = process.env.MB_MAIN_FIELD  || 'Main (Menu Item)';
const MB_SIDE_FIELD  = process.env.MB_SIDE_FIELD  || 'Side (Menu Item)';
const MB_LINE_TYPE   = process.env.MB_LINE_TYPE   || 'Line Type';

// В Order Lines (дочерняя): как называются поля
const OL_ORDER_FIELD = process.env.OL_ORDER_FIELD || 'Order';
const OL_ITEM_FIELD  = process.env.OL_ITEM_FIELD  || 'Item (Menu Item)';
const OL_QTY_FIELD   = process.env.OL_QTY_FIELD   || 'Quantity';
const OL_LINE_TYPE   = process.env.OL_LINE_TYPE   || 'Line Type';

// Значения Single select
const LINE_TYPE_INCLUDED = process.env.LINE_TYPE_INCLUDED || 'Included';
const ORDER_TYPE_EMP     = process.env.ORDER_TYPE_EMP     || 'Employee';
const STATUS_NEW         = process.env.STATUS_NEW         || 'New';

// --- helpers ---
async function employeeAllowed(employeeID, org, token) {
  // ВНИМАНИЕ: имя lookup-поля с OrgID в Employees подставь как у тебя в базе
  const EMP_ORG_LOOKUP = process.env.EMP_ORG_LOOKUP || 'OrgID (from Organization)';
  const emp = await aFindOne(
    T.employees,
    `AND(
      RECORD_ID()='${fstr(employeeID)}',
      {Status}!='Inactive',
      {Order Token}='${fstr(token)}',
      FIND('${fstr(org)}', {${EMP_ORG_LOOKUP}} & '') > 0
    )`
  );
  return emp;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { employeeID, org, token, date, included } = req.body || {};
    if (!employeeID || !org || !token || !date || !included) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 1) Верификация
    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    // 2) Дата доступна
    const menuDate = await aFindOne(
      T.menu,
      `AND(
        {Published}=1,
        IS_SAME({Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
        OR({AccessLine}='ALL', FIND('${fstr(org)}', {AccessLine}))
      )`
    );
    if (!menuDate) return res.status(400).json({ error: 'date is not available for this org' });

    // 3) Анти-дубль
    const dup = await aFindOne(
      T.orders,
      `AND(
        {Employee}='${fstr(employeeID)}',
        IS_SAME({Order Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
        {Status}!='Cancelled'
      )`
    );
    if (dup) return res.status(200).json({ ok: true, duplicate: true, orderId: dup.id });

    // 4) Создаём Order
    const o = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': ORDER_TYPE_EMP,
      'Status': STATUS_NEW,
      'Employee': [{ id: employeeID }]
    }]);
    const orderId = o.records[0].id;

    // 5) Extras (до 2)
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0, 2) : [];
    let createdOL = 0, createdMB = 0;
    let olIds = [];

    if (extras.length) {
      const records = extras.map(id => ({
        [OL_ORDER_FIELD]: [{ id: orderId }],
        [OL_ITEM_FIELD]:  [{ id }],
        [OL_QTY_FIELD]:   1,
        [OL_LINE_TYPE]:   LINE_TYPE_INCLUDED
      }));
      const r1 = await aCreate(T.orderlines, records);
      createdOL = (r1.records || []).length;
      olIds = (r1.records || []).map(x => ({ id: x.id }));
    }

    // 6) Meal Box
    if (!included.mainId) return res.status(400).json({ error: 'mainId required' });

    const mbRec = {
      [MB_ORDER_FIELD]: [{ id: orderId }],
      [MB_MAIN_FIELD]:  [{ id: included.mainId }],
      [MB_LINE_TYPE]:   LINE_TYPE_INCLUDED,
      'Quantity': 1
    };
    if (included.sideId) mbRec[MB_SIDE_FIELD] = [{ id: included.sideId }];

    const r2 = await aCreate(T.mealboxes, [mbRec]);
    createdMB = (r2.records || []).length;
    const mbIds = (r2.records || []).map(x => ({ id: x.id }));

    // 7) На родителе проставим обратные ссылки (на случай, если у тебя кастомные названия)
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        [ORDER_OL_LINK_FIELD]: olIds,
        [ORDER_MB_LINK_FIELD]: mbIds
      }
    }]);

    res.status(200).json({ ok: true, orderId, created: { orderLines: createdOL, mealBoxes: createdMB } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
