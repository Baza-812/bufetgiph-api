// api/order.js
import { aGet, aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

const ORDER_TYPE_EMP = 'Employee';
const STATUS_NEW     = 'New';
const LINE_INCLUDED  = 'Included';

// Родительские линки в Orders
const ORDERS_OL_FIELD = process.env.ORDERS_OL_FIELD || 'Order Lines';
const ORDERS_MB_FIELD = process.env.ORDERS_MB_FIELD || 'Meal Boxes';

// Link-поля к Menu в детях (боевые имена + фолбэки на TEST)
const OL_ITEM_FIELD = process.env.OL_ITEM_FIELD || 'Item (Menu Item)';
const MB_MAIN_FIELD = process.env.MB_MAIN_FIELD || 'Main (Menu Item)';
const MB_SIDE_FIELD = process.env.MB_SIDE_FIELD || 'Side (Menu Item)';

const OL_ITEM_CANDIDATES = Array.from(new Set([OL_ITEM_FIELD, 'Item (Menu Item)', 'Item TEST']));
const MB_MAIN_CANDIDATES = Array.from(new Set([MB_MAIN_FIELD, 'Main (Menu Item)', 'Main TEST']));
const MB_SIDE_CANDIDATES = Array.from(new Set([MB_SIDE_FIELD, 'Side (Menu Item)', 'Side TEST']));

const EMP_ORG_LOOKUP     = process.env.EMP_ORG_LOOKUP || 'OrgID (from Organization)';
const MENU_ACCESS_FIELD  = process.env.MENU_ACCESS_FIELD || 'AccessLine';

const orByIds = (ids) =>
  ids && ids.length ? `OR(${ids.map((id) => `RECORD_ID()='${fstr(id)}'`).join(',')})` : "FALSE()";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// Пробуем несколько имён полей; возвращаем, по каким именам апдейт прошёл
async function safeUpdate(table, records, fieldNames) {
  const tried = [];
  const ok = [];
  for (const fname of fieldNames) {
    const payload = records
      .map(r => {
        const v = r.fields?.[fname];
        return v ? { id: r.id, fields: { [fname]: v } } : null;
      })
      .filter(Boolean);
    if (!payload.length) { tried.push({ fname, used: 0 }); continue; }

    tried.push({ fname, used: payload.length });
    try {
      await aUpdate(table, payload, true); // typecast: true
      ok.push(fname);
      // Не выходим — возможно часть данных ушла под альтернативным именем
    } catch (e) {
      const msg = (e?.message || '').toString();
      if (!/UNKNOWN_FIELD_NAME/i.test(msg)) throw e; // другие ошибки не глотаем
    }
  }
  return { tried, ok };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { employeeID, org, token, date, included } = req.body || {};
    if (!employeeID || !org || !token || !date || !included?.mainId) {
      return res.status(400).json({ error: 'missing fields' });
    }

    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    const menuOk = await dateAllowed(date, org);
    if (!menuOk) return res.status(400).json({ error: 'date is not available for this org' });

    const dup = await hasDuplicate(employeeID, date);
    if (dup) return res.status(200).json({ ok: true, duplicate: true, orderId: dup.id });

    // 1) Создаём заказ
    const orderResp = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': ORDER_TYPE_EMP,
      'Status'    : STATUS_NEW,
      'Employee'  : [{ id: employeeID }],
    }]);
    const orderId = orderResp.records[0].id;

    // 2) Дети (кол-во OL = кол-ву extras (<=2), MB всегда 1)
    const extras = Array.isArray(included.extras) ? included.extras.slice(0, 2) : [];
    const createOL = extras.map(() => ({
      'Quantity' : 1,
      'Line Type': LINE_INCLUDED,
    }));
    const createMB = [{ 'Quantity': 1, 'Line Type': LINE_INCLUDED }];

    let olIds = [];
    if (createOL.length) {
      const r = await aCreate(T.orderlines, createOL);
      olIds = (r.records || []).map(x => x.id);
    }
    const rmb = await aCreate(T.mealboxes, createMB);
    const mbIds = (rmb.records || []).map(x => x.id);
    const mbId = mbIds[0];

    // Небольшая пауза — Airtable иногда индексирует запись доли секунды
    await sleep(150);

    // 3) Пришиваем детей к заказу (родительские поля)
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        [ORDERS_OL_FIELD]: olIds,
        [ORDERS_MB_FIELD]: mbIds,
      }
    }], true);

    // 4) Проставляем меню в детях — по ИМЕНАМ, с фолбэками и логом
    const writeLog = { ol_item: {}, mb_main: {}, mb_side: {} };

    // 4.1 OL → Item
    if (olIds.length && extras.length) {
      const olRecords = olIds.map((id, i) => {
        const itemId = extras[i];
        return itemId ? { id, fields: { [OL_ITEM_FIELD]: [{ id: itemId }] } } : null;
        }).filter(Boolean);
      writeLog.ol_item = await safeUpdate(T.orderlines, olRecords, OL_ITEM_CANDIDATES);
    }

    // 4.2 MB → Main/Side
    if (mbId) {
      if (included.mainId) {
        const recs = [{ id: mbId, fields: { [MB_MAIN_FIELD]: [{ id: included.mainId }] } }];
        writeLog.mb_main = await safeUpdate(T.mealboxes, recs, MB_MAIN_CANDIDATES);
      }
      if (included.sideId) {
        const recs = [{ id: mbId, fields: { [MB_SIDE_FIELD]: [{ id: included.sideId }] } }];
        writeLog.mb_side = await safeUpdate(T.mealboxes, recs, MB_SIDE_CANDIDATES);
      }
    }

    // 5) Read-back
    const rOrd = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDERS_OL_FIELD, ORDERS_MB_FIELD],
    });
    const order = (rOrd.records && rOrd.records[0]) || null;

    let orderLines = [];
    if (olIds.length) {
      const rOL = await aGet(T.orderlines, { filterByFormula: orByIds(olIds) });
      orderLines = rOL.records || [];
    }
    let mealBoxes = [];
    if (mbId) {
      const rMB2 = await aGet(T.mealboxes, { filterByFormula: orByIds([mbId]) });
      mealBoxes = rMB2.records || [];
    }

    return res.status(200).json({
      ok: true,
      orderId,
      ids: { orderLines: olIds, mealBoxes: mbIds },
      writeLog,
      readBack: { order, orderLines, mealBoxes }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
