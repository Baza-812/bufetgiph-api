// api/order.js
import { aGet, aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

/**
 * ======================
 * Константы и настройки
 * ======================
 */
const ORDER_TYPE_EMP = 'Employee';
const STATUS_NEW = 'New';
const LINE_INCLUDED = 'Included';

// Имя lookup-поля с кодом организации у сотрудника (в Employees)
const EMP_ORG_LOOKUP = process.env.EMP_ORG_LOOKUP || 'OrgID (from Organization)';

// Поле-доступа в Menu (строка: 'ALL' или список кодов через разделитель)
const MENU_ACCESS_FIELD = process.env.MENU_ACCESS_FIELD || 'AccessLine';

// Имена (или ID) ссылочных полей в Orders (родительские поля)
const ORDERS_OL_FIELD = process.env.ORDERS_OL_FIELD || 'Order Lines';
const ORDERS_MB_FIELD = process.env.ORDERS_MB_FIELD || 'Meal Boxes';

/**
 * Утилиты
 */
const orByIds = (ids) =>
  ids && ids.length ? `OR(${ids.map((id) => `RECORD_ID()='${fstr(id)}'`).join(',')})` : "FALSE()";

/**
 * Проверка, что сотрудник может делать заказ:
 *  - активен
 *  - токен совпадает
 *  - принадлежит организации org (совпадение по EMP_ORG_LOOKUP)
 */
async function employeeAllowed(employeeID, org, token) {
  return aFindOne(
    T.employees,
    `AND(
      RECORD_ID()='${fstr(employeeID)}',
      {Status}!='Inactive',
      {Order Token}='${fstr(token)}',
      OR({${EMP_ORG_LOOKUP}}='${fstr(org)}', FIND('${fstr(org)}', {${EMP_ORG_LOOKUP}} & '') > 0)
    )`
  );
}

/**
 * Проверка доступности меню на дату для организации
 */
async function dateAllowed(date, org) {
  return aFindOne(
    T.menu,
    `AND(
      {Published}=1,
      IS_SAME({Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
      OR({${MENU_ACCESS_FIELD}}='ALL', FIND('${fstr(org)}', {${MENU_ACCESS_FIELD}} & '') > 0)
    )`
  );
}

/**
 * Проверка дубля заказа (на дату и сотрудника)
 */
async function hasDuplicate(employeeID, date) {
  return aFindOne(
    T.orders,
    `AND(
      {Employee}='${fstr(employeeID)}',
      IS_SAME({Order Date}, DATETIME_PARSE('${fstr(date)}'), 'day'),
      {Status}!='Cancelled'
    )`
  );
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { employeeID, org, token, date, included } = req.body || {};

    // Валидации входа
    if (!employeeID || !org || !token || !date || !included?.mainId) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 1) Доступ сотрудника и даты
    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    const menuOk = await dateAllowed(date, org);
    if (!menuOk) return res.status(400).json({ error: 'date is not available for this org' });

    const dup = await hasDuplicate(employeeID, date);
    if (dup) {
      return res.status(200).json({ ok: true, duplicate: true, orderId: dup.id });
    }

    // 2) Создаём заказ
    const orderResp = await aCreate(T.orders, [
      {
        'Order Date': date,
        'Order Type': ORDER_TYPE_EMP,
        'Status': STATUS_NEW,
        'Employee': [{ id: employeeID }],
      },
    ]);
    const orderId = orderResp.records[0].id;

    // 3) Создаём детей (без ссылок на Order) + сразу пробуем проставить ссылки на меню
    const extras = Array.isArray(included.extras) ? included.extras.slice(0, 2) : [];
    const toCreateOL = extras.map((extraId) => ({
      'Quantity': 1,
      'Line Type': LINE_INCLUDED,
      // попробуем сразу связать с меню (Item)
      ...(extraId ? { 'Item (Menu Item)': [{ id: extraId }] } : {}),
    }));
    const toCreateMB = [{
      'Quantity': 1,
      'Line Type': LINE_INCLUDED,
      'Main (Menu Item)': [{ id: included.mainId }],
      ...(included.sideId ? { 'Side (Menu Item)': [{ id: included.sideId }] } : {}),
    }];

    let olIds = [];
    if (toCreateOL.length) {
      const olResp = await aCreate(T.orderlines, toCreateOL);
      olIds = (olResp.records || []).map((r) => r.id);
    }
    const mbResp = await aCreate(T.mealboxes, toCreateMB);
    const mbIds = (mbResp.records || []).map((r) => r.id);

    // 4) Пришиваем детей к заказу СО СТОРОНЫ РОДИТЕЛЯ
    //    (как в официальном мануале Airtable) — передаём ПОЛНЫЙ список детей.
    const fieldsForParent = {};
    fieldsForParent[ORDERS_OL_FIELD] = olIds; // массив rec-id строк
    fieldsForParent[ORDERS_MB_FIELD] = mbIds; // массив rec-id коробок

    await aUpdate(T.orders, [
      {
        id: orderId,
        fields: fieldsForParent,
      },
    ]);

    // 5) Контрольный read-back: читаем детей и родителя
    const readBack = { order: null, orderLines: [], mealBoxes: [] };

    if (olIds.length) {
      const rOL = await aGet(T.orderlines, { filterByFormula: orByIds(olIds) });
      readBack.orderLines = rOL.records || [];
    }
    const rMB = await aGet(T.mealboxes, { filterByFormula: orByIds(mbIds) });
    readBack.mealBoxes = rMB.records || [];

    const rOrd = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDERS_OL_FIELD, ORDERS_MB_FIELD],
    });
    readBack.order = (rOrd.records && rOrd.records[0]) || null;

    return res.status(200).json({
      ok: true,
      orderId,
      ids: { orderLines: olIds, mealBoxes: mbIds },
      readBack,
    });
  } catch (e) {
    // Вернём понятное сообщение
    return res.status(500).json({ error: e.message || String(e) });
  }
}
