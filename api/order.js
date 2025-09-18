// api/order.js
import { aGet, aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

// --- настроечные ключи (можно переопределить через ENV, иначе берутся дефолты) ---
const ORDER_MB_LINK_FIELD = process.env.ORDER_MB_LINK_FIELD || 'Meal Boxes';
const ORDER_OL_LINK_FIELD = process.env.ORDER_OL_LINK_FIELD || 'Order Lines';

const MB_ORDER_FIELD = process.env.MB_ORDER_FIELD || 'Order';
const MB_MAIN_FIELD  = process.env.MB_MAIN_FIELD  || 'Main (Menu Item)';
const MB_SIDE_FIELD  = process.env.MB_SIDE_FIELD  || 'Side (Menu Item)';
const MB_LINE_TYPE   = process.env.MB_LINE_TYPE   || 'Line Type';

const OL_ORDER_FIELD = process.env.OL_ORDER_FIELD || 'Order';
const OL_ITEM_FIELD  = process.env.OL_ITEM_FIELD  || 'Item (Menu Item)';
const OL_QTY_FIELD   = process.env.OL_QTY_FIELD   || 'Quantity';
const OL_LINE_TYPE   = process.env.OL_LINE_TYPE   || 'Line Type';

const LINE_TYPE_INCLUDED = process.env.LINE_TYPE_INCLUDED || 'Included';
const ORDER_TYPE_EMP     = process.env.ORDER_TYPE_EMP     || 'Employee';
const STATUS_NEW         = process.env.STATUS_NEW         || 'New';

const EMP_ORG_LOOKUP     = process.env.EMP_ORG_LOOKUP     || 'OrgID (from Organization)';
const MENU_ACCESS_FIELD  = process.env.MENU_ACCESS_FIELD  || 'AccessLine';

// --- helpers ---
async function employeeAllowed(employeeID, org, token) {
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

    // 1) сотрудник ок?
    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    // 2) дата доступна этой org?
    const menuDate = await aFindOne(
      T.menu,
      `AND(
        {Published}=1,
        IS_SAME({Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
        OR({${MENU_ACCESS_FIELD}}='ALL', FIND('${fstr(org)}', {${MENU_ACCESS_FIELD}} & ''))
      )`
    );
    if (!menuDate) return res.status(400).json({ error: 'date is not available for this org' });

    // 3) анти-дубль
    const dup = await aFindOne(
      T.orders,
      `AND(
        {Employee}='${fstr(employeeID)}',
        IS_SAME({Order Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
        {Status}!='Cancelled'
      )`
    );
    if (dup) return res.status(200).json({ ok: true, duplicate: true, orderId: dup.id });

    // 4) создаём Order
    const o = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': ORDER_TYPE_EMP,
      'Status': STATUS_NEW,
      'Employee': [{ id: employeeID }]
    }]);
    const orderId = o.records[0].id;

    // 5) создаём детей (ПОКА БЕЗ ССЫЛКИ НА ЗАКАЗ)
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0, 2) : [];

    let createdOL = 0, createdMB = 0;
    let olIds = [], mbIds = [];

    if (extras.length) {
      const records = extras.map(id => ({
        [OL_ITEM_FIELD]: [{ id }],
        [OL_QTY_FIELD]: 1,
        [OL_LINE_TYPE]: LINE_TYPE_INCLUDED
      }));
      const r1 = await aCreate(T.orderlines, records);
      createdOL = (r1.records || []).length;
      olIds = (r1.records || []).map(x => x.id); // массив СТРОК (id)
    }

    if (!included.mainId) return res.status(400).json({ error: 'mainId required' });
    const mbRec = {
      [MB_MAIN_FIELD]: [{ id: included.mainId }],
      [MB_LINE_TYPE]: LINE_TYPE_INCLUDED,
      'Quantity': 1
    };
    if (included.sideId) mbRec[MB_SIDE_FIELD] = [{ id: included.sideId }];

    const r2 = await aCreate(T.mealboxes, [mbRec]);
    createdMB = (r2.records || []).length;
    mbIds = (r2.records || []).map(x => x.id);

    // 6) пытаемся привязать с РОДИТЕЛЯ
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        [ORDER_OL_LINK_FIELD]: olIds,  // массив строк-ID
        [ORDER_MB_LINK_FIELD]: mbIds
      }
    }]);

    // 7) проверяем, что привязка встала
    const vr = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDER_OL_LINK_FIELD, ORDER_MB_LINK_FIELD]
    });
    const ordFields = vr.records?.[0]?.fields || {};
    const linkedOL = Array.isArray(ordFields[ORDER_OL_LINK_FIELD]) ? ordFields[ORDER_OL_LINK_FIELD].length : 0;
    const linkedMB = Array.isArray(ordFields[ORDER_MB_LINK_FIELD]) ? ordFields[ORDER_MB_LINK_FIELD].length : 0;

    let fallback = { ol: false, mb: false };

    // 8) если не подцепилось — делаем ЗАПАСНОЙ ХОД: ставим заказ в детях
    if (linkedOL < olIds.length && olIds.length) {
      await aUpdate(T.orderlines, olIds.map(id => ({
        id, fields: { [OL_ORDER_FIELD]: [{ id: orderId }] }
      })));
      fallback.ol = true;
    }
    if (linkedMB < mbIds.length && mbIds.length) {
      await aUpdate(T.mealboxes, mbIds.map(id => ({
        id, fields: { [MB_ORDER_FIELD]: [{ id: orderId }] }
      })));
      fallback.mb = true;
    }

    res.status(200).json({
      ok: true,
      orderId,
      created: { orderLines: createdOL, mealBoxes: createdMB },
      ids: { orderLines: olIds, mealBoxes: mbIds },
      linked: { fromParent: { ol: linkedOL, mb: linkedMB }, fallback }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
