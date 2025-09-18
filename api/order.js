// api/order.js
import { aGet, aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

// Поля в Orders (родитель) — оставим на дефолтах
const ORDER_MB_LINK_FIELD = 'Meal Boxes';
const ORDER_OL_LINK_FIELD = 'Order Lines';

// Опции
const LINE_TYPE_INCLUDED = 'Included';
const ORDER_TYPE_EMP     = 'Employee';
const STATUS_NEW         = 'New';

// Lookup и доступ
const EMP_ORG_LOOKUP    = process.env.EMP_ORG_LOOKUP    || 'OrgID (from Organization)';
const MENU_ACCESS_FIELD = process.env.MENU_ACCESS_FIELD || 'AccessLine';

async function employeeAllowed(employeeID, org, token) {
  return await aFindOne(
    T.employees,
    `AND(
      RECORD_ID()='${fstr(employeeID)}',
      {Status}!='Inactive',
      {Order Token}='${fstr(token)}',
      FIND('${fstr(org)}', {${EMP_ORG_LOOKUP}} & '') > 0
    )`
  );
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
        OR({${MENU_ACCESS_FIELD}}='ALL', FIND('${fstr(org)}', {${MENU_ACCESS_FIELD}} & ''))
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

    // 5) Создаём детей (пока пустые, без ссылок) — потом дозагоним PATCH'ем
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0, 2) : [];
    let olIds = [], mbIds = [];

    // Order Lines
    if (extras.length) {
      const r1 = await aCreate(T.orderlines, extras.map(() => ({
        // поля поставим ниже PATCH'ем
        'Quantity': 1,
        'Line Type': LINE_TYPE_INCLUDED
      })));
      olIds = (r1.records || []).map(x => x.id);
    }

    // Meal Box (одна коробка)
    const r2 = await aCreate(T.mealboxes, [{
      'Quantity': 1,
      'Line Type': LINE_TYPE_INCLUDED
      // main/side дозагоним PATCH'ем
    }]);
    mbIds = (r2.records || []).map(x => x.id);

    // 6) Жёстко проставляем поля в детях PATCH'ем (используем ТОЛЬКО дефолтные имена)
    // Order Lines: Item (Menu Item) + Order
    if (olIds.length) {
      const updates = olIds.map((id, i) => ({
        id,
        fields: {
          'Item (Menu Item)': [{ id: extras[i] }],
          'Order': [{ id: orderId }],
          'Quantity': 1,
          'Line Type': LINE_TYPE_INCLUDED
        }
      }));
      await aUpdate(T.orderlines, updates);
    }

    // Meal Box: Main/Side + Order
    if (!included.mainId) return res.status(400).json({ error: 'mainId required' });
    {
      const fields = {
        'Main (Menu Item)': [{ id: included.mainId }],
        'Order': [{ id: orderId }],
        'Quantity': 1,
        'Line Type': LINE_TYPE_INCLUDED
      };
      if (included.sideId) fields['Side (Menu Item)'] = [{ id: included.sideId }];
      await aUpdate(T.mealboxes, [{ id: mbIds[0], fields }]);
    }

    // 7) Привязываем детей на родителе (на всякий случай)
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        [ORDER_OL_LINK_FIELD]: olIds.map(id => ({ id })),
        [ORDER_MB_LINK_FIELD]: mbIds.map(id => ({ id }))
      }
    }]);

    // 8) Контрольный снятый слепок (сколько подцепилось на родителе)
    const ordCheck = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDER_OL_LINK_FIELD, ORDER_MB_LINK_FIELD]
    });
    const linkedOL = ordCheck.records?.[0]?.fields?.[ORDER_OL_LINK_FIELD]?.length || 0;
    const linkedMB = ordCheck.records?.[0]?.fields?.[ORDER_MB_LINK_FIELD]?.length || 0;

    res.status(200).json({
      ok: true,
      orderId,
      created: { orderLines: olIds.length, mealBoxes: mbIds.length },
      ids: { orderLines: olIds, mealBoxes: mbIds },
      linked: { ol: linkedOL, mb: linkedMB }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
