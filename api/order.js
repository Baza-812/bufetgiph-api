// api/order.js
import { aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

/**
 * Проверка сотрудника:
 * - запись существует и не Inactive
 * - токен совпадает
 * - сотрудник принадлежит переданной org (по lookup `OrgID (from Organization)`)
 *
 * ВАЖНО: если у тебя lookup называется иначе, замени имя поля в формуле ниже.
 */
async function employeeAllowed(employeeID, org, token) {
  const emp = await aFindOne(
    T.employees,
    `AND(
      RECORD_ID()='${fstr(employeeID)}',
      {Status}!='Inactive',
      {Order Token}='${fstr(token)}',
      FIND('${fstr(org)}', {OrgID (from Organization)} & '') > 0
    )`
  );
  return emp;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }

    const { employeeID, org, token, date, included } = req.body || {};
    if (!employeeID || !org || !token || !date || !included) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 1) Верификация сотрудника
    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    // 2) Дата доступна (Published + доступ org)
    const menuDate = await aFindOne(
      T.menu,
      `AND(
        {Published}=1,
        IS_SAME({Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
        OR({AccessLine}='ALL', FIND('${fstr(org)}', {AccessLine}))
      )`
    );
    if (!menuDate) {
      return res.status(400).json({ error: 'date is not available for this org' });
    }

    // 3) Анти-дубль (на сотрудника и день)
    const dup = await aFindOne(
      T.orders,
      `AND(
        {Employee}='${fstr(employeeID)}',
        IS_SAME({Order Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
        {Status}!='Cancelled'
      )`
    );
    if (dup) {
      return res.status(200).json({ ok: true, duplicate: true, orderId: dup.id });
    }

    // 4) Создаём Order (single select — строками; typecast включён в aCreate)
    const o = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': 'Employee',
      'Status': 'New',
      'Employee': [{ id: employeeID }]
    }]);
    const orderId = o.records[0].id;

    // 5) Included extras (до 2 строк)
    const extras = Array.isArray(included?.extras) ? included.extras.slice(0, 2) : [];
    let createdOL = 0, createdMB = 0;
    let olIds = [];

    if (extras.length) {
      const r1 = await aCreate(
        T.orderlines,
        extras.map(id => ({
          'Order': [{ id: orderId }],           // обратная ссылка всё равно закрепим на родителе
          'Item (Menu Item)': [{ id }],
          'Quantity': 1,
          'Line Type': 'Included'
        }))
      );
      createdOL = (r1.records || []).length;
      olIds = (r1.records || []).map(x => ({ id: x.id }));
    }

    // 6) Meal Box (main + side|null)
    if (!included.mainId) {
      return res.status(400).json({ error: 'mainId required' });
    }

    const mbRec = {
      'Order': [{ id: orderId }],
      'Main (Menu Item)': [{ id: included.mainId }],
      'Quantity': 1,
      'Line Type': 'Included'
      // 'Packaging': 'В одном' // можно вернуть позже, когда опция точно есть в селекте
    };
    if (included.sideId) {
      mbRec['Side (Menu Item)'] = [{ id: included.sideId }];
    }

    const r2 = await aCreate(T.mealboxes, [mbRec]);
    createdMB = (r2.records || []).length;
    const mbIds = (r2.records || []).map(x => ({ id: x.id }));

    // 7) Жёстко прикрепляем дочерние к родителю (на случай, если имя поля в дочерней таблице отличается)
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        'Order Lines': olIds,   // ИМЕНА ПОЛЕЙ В ORDERS: должны совпадать с твоими
        'Meal Boxes': mbIds
      }
    }]);

    // 8) Ответ
    res.status(200).json({
      ok: true,
      orderId,
      created: { orderLines: createdOL, mealBoxes: createdMB }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
