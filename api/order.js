// api/order.js
import { aGet, aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

// ---- CONFIG (ENV -> иначе дефолты) ----
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

// маленький хелпер чтобы писать сразу в 2 возможных названия поля
const both = (A, B, v) => ({ [A]: v, [B]: v });

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

    // 1) верификация сотрудника
    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    // 2) дата доступна org
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

    // 5) создаём детей (пока без Order, потом привяжем с родителя)
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0, 2) : [];
    let olIds = [], mbIds = [];

    if (extras.length) {
      const recs = extras.map(id => ({
        ...both(OL_ITEM_FIELD, 'Item (Menu Item)', [{ id }]),
        [OL_QTY_FIELD]: 1,
        [OL_LINE_TYPE]: LINE_TYPE_INCLUDED
      }));
      const r1 = await aCreate(T.orderlines, recs);
      olIds = (r1.records || []).map(x => x.id);
    }

    if (!included.mainId) return res.status(400).json({ error: 'mainId required' });

    const mbRec = {
      ...both(MB_MAIN_FIELD, 'Main (Menu Item)', [{ id: included.mainId }]),
      [MB_LINE_TYPE]: LINE_TYPE_INCLUDED,
      'Quantity': 1
    };
    if (included.sideId) Object.assign(
      mbRec,
      both(MB_SIDE_FIELD, 'Side (Menu Item)', [{ id: included.sideId }])
    );
    const r2 = await aCreate(T.mealboxes, [mbRec]);
    mbIds = (r2.records || []).map(x => x.id);

    // 6) привязка с родителя
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        [ORDER_OL_LINK_FIELD]: olIds,
        [ORDER_MB_LINK_FIELD]: mbIds
      }
    }]);

    // 7) читаем назад: сами дети + родительские ссылки
    const olDetail = olIds.length
      ? await aGet(T.orderlines, { filterByFormula: `OR(${olIds.map(id=>`RECORD_ID()='${id}'`).join(',')})` })
      : { records: [] };
    const mbDetail = mbIds.length
      ? await aGet(T.mealboxes, { filterByFormula: `OR(${mbIds.map(id=>`RECORD_ID()='${id}'`).join(',')})` })
      : { records: [] };
    const ordCheck = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDER_OL_LINK_FIELD, ORDER_MB_LINK_FIELD]
    });

    // 8) если не подцепилось — запасной ход: ставим Order в детях (и снова читаем)
    let fallback = { ol:false, mb:false };
    const linkedOL = ordCheck.records?.[0]?.fields?.[ORDER_OL_LINK_FIELD]?.length || 0;
    const linkedMB = ordCheck.records?.[0]?.fields?.[ORDER_MB_LINK_FIELD]?.length || 0;

    if (linkedOL < olIds.length && olIds.length) {
      await aUpdate(T.orderlines, olIds.map(id => ({ id, fields: both(OL_ORDER_FIELD, 'Order', [{ id: orderId }]) })));
      fallback.ol = true;
    }
    if (linkedMB < mbIds.length && mbIds.length) {
      await aUpdate(T.mealboxes, mbIds.map(id => ({ id, fields: both(MB_ORDER_FIELD, 'Order', [{ id: orderId }]) })));
      fallback.mb = true;
    }

    const ordCheck2 = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDER_OL_LINK_FIELD, ORDER_MB_LINK_FIELD]
    });

    res.status(200).json({
      ok: true,
      orderId,
      created: { orderLines: olIds.length, mealBoxes: mbIds.length },
      ids: { orderLines: olIds, mealBoxes: mbIds },
      // вот тут ПОЛЯ дочерних записей — смотрим содержимое
      children: {
        mealBoxes: mbDetail.records?.map(r => ({ id:r.id, fields:r.fields })) || [],
        orderLines: olDetail.records?.map(r => ({ id:r.id, fields:r.fields })) || []
      },
      linked: {
        fromParent_before: { ol: linkedOL, mb: linkedMB },
        fallback_applied: fallback,
        fromParent_after: {
          ol: ordCheck2.records?.[0]?.fields?.[ORDER_OL_LINK_FIELD]?.length || 0,
          mb: ordCheck2.records?.[0]?.fields?.[ORDER_MB_LINK_FIELD]?.length || 0
        }
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
