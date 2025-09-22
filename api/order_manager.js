// api/order_manager.js
import { aGet, aFindOne, aCreate, aUpdate, T, fstr, cors } from './_lib/air.js';

const ORDER_TYPE_MANAGER = 'Manager';
const STATUS_NEW         = 'New';
const LINE_INCLUDED      = 'Included';

// Родительские линки в Orders
const ORDERS_OL_FIELD = process.env.ORDERS_OL_FIELD || 'Order Lines';
const ORDERS_MB_FIELD = process.env.ORDERS_MB_FIELD || 'Meal Boxes';

// Link-поля к Menu в детях (боевые имена + фолбэки)
const OL_ITEM_FIELD = process.env.OL_ITEM_FIELD || 'Item (Menu Item)';
const MB_MAIN_FIELD = process.env.MB_MAIN_FIELD || 'Main (Menu Item)';
const MB_SIDE_FIELD = process.env.MB_SIDE_FIELD || 'Side (Menu Item)';

const OL_ITEM_CANDIDATES = Array.from(new Set([OL_ITEM_FIELD, 'Item (Menu Item)', 'Item TEST']));
const MB_MAIN_CANDIDATES = Array.from(new Set([MB_MAIN_FIELD, 'Main (Menu Item)', 'Main TEST']));
const MB_SIDE_CANDIDATES = Array.from(new Set([MB_SIDE_FIELD, 'Side (Menu Item)', 'Side TEST']));

// (ОПЦИОНАЛЬНО) редактируемые поля-для-ввода разбивки, если хочешь хранить отдельно
const MB_QTY_STD_INPUT = (process.env.MB_QTY_STD_INPUT_FIELD || '').trim();   // напр. "Qty Std (Input)"
const MB_QTY_UPS_INPUT = (process.env.MB_QTY_UPS_INPUT_FIELD || '').trim();   // напр. "Qty Upsized (Input)"

const EMP_ORG_LOOKUP     = process.env.EMP_ORG_LOOKUP || 'OrgID (from Organization)';
const MENU_ACCESS_FIELD  = process.env.MENU_ACCESS_FIELD || 'AccessLine';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const orByIds = (ids) =>
  ids && ids.length ? `OR(${ids.map((id) => `RECORD_ID()='${fstr(id)}'`).join(',')})` : "FALSE()";

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

// безопасный апдейт: пробуем несколько имён полей; значения — МАССИВЫ СТРОК rec…
async function safeUpdateLinks(table, records, fieldNames) {
  const tried = []; const ok = [];
  for (const fname of fieldNames) {
    const chunk = records
      .map(r => {
        const v = r.fields?.[fname]; // ожидаем массив строк
        const good = Array.isArray(v) && v.length && typeof v[0] === 'string';
        return good ? { id: r.id, fields: { [fname]: v } } : null;
      }).filter(Boolean);
    tried.push({ fname, used: chunk.length });
    if (!chunk.length) continue;

    try { await aUpdate(table, chunk, true); ok.push(fname); }
    catch (e) {
      const msg = (e?.message || '').toString();
      if (!/UNKNOWN_FIELD_NAME/i.test(msg)) throw e;
    }
  }
  return { tried, ok };
}

// апдейт числовых полей для разбивки; игнорируем "computed" ошибки
async function tryUpdateNumbers(table, records) {
  if (!records.length) return { updated: 0, skipped: true };
  try {
    await aUpdate(table, records, true);
    return { updated: records.length, skipped: false };
  } catch (e) {
    const msg = (e?.message || '').toString();
    if (/computed/i.test(msg) || /INVALID_VALUE_FOR_COLUMN/i.test(msg)) {
      // поля вычисляемые — пропускаем
      return { updated: 0, skipped: true, reason: 'computed' };
    }
    throw e;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { employeeID, org, token, date, boxes, extras } = req.body || {};
    // boxes: [{ mainId, sideId, qtyStandard, qtyUpsized }]
    // extras: [{ itemId, qty }]
    if (!employeeID || !org || !token || !date || !Array.isArray(boxes) || boxes.length === 0) {
      return res.status(400).json({ error: 'missing fields (employeeID, org, token, date, boxes[])' });
    }

    const emp = await employeeAllowed(employeeID, org, token);
    if (!emp) return res.status(403).json({ error: 'employee not allowed' });

    const menuOk = await dateAllowed(date, org);
    if (!menuOk) return res.status(400).json({ error: 'date is not available for this org' });

    // 1) заказ
    const orderResp = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': 'Manager',
      'Status'    : STATUS_NEW,
      'Employee'  : [{ id: employeeID }],
    }]);
    const orderId = orderResp.records[0].id;

    // 2) создаём Meal Boxes — ТОЛЬКО Quantity + Line Type (не трогаем вычисляемые qty-поля)
    const mbPayload = boxes.map(b => {
      const qtyS = Math.max(0, Number(b.qtyStandard||0));
      const qtyU = Math.max(0, Number(b.qtyUpsized||0));
      const qty  = qtyS + qtyU;
      return { 'Quantity': qty, 'Line Type': LINE_INCLUDED };
    });
    const rMB = await aCreate(T.mealboxes, mbPayload);
    const mbIds = (rMB.records||[]).map(r=>r.id);

    // 3) создаём Order Lines для extras
    let olIds = [];
    if (Array.isArray(extras) && extras.length) {
      const olPayload = extras
        .filter(x => x?.itemId && Number(x?.qty) > 0)
        .map(x => ({ 'Quantity': Number(x.qty), 'Line Type': LINE_INCLUDED }));
      if (olPayload.length) {
        const rOL = await aCreate(T.orderlines, olPayload);
        olIds = (rOL.records||[]).map(r=>r.id);
      }
    }

    await sleep(150);

    // 4) пришиваем детей к заказу
    await aUpdate(T.orders, [{
      id: orderId,
      fields: { [ORDERS_MB_FIELD]: mbIds, [ORDERS_OL_FIELD]: olIds }
    }], true);

    await sleep(150);

    // 5) привязываем Menu (массивы строк)
    const writeLog = { mb_main: {}, mb_side: {}, ol_item: {}, qty_inputs: {} };

    // 5.1 Meal Boxes: main/side по позициям boxes[i]
    const mbMainRecs = [];
    const mbSideRecs = [];
    mbIds.forEach((id, i) => {
      const b = boxes[i] || {};
      if (b.mainId) mbMainRecs.push({ id, fields: { [MB_MAIN_FIELD]: [ b.mainId ] } });
      if (b.sideId) mbSideRecs.push({ id, fields: { [MB_SIDE_FIELD]: [ b.sideId ] } });
    });
    if (mbMainRecs.length) writeLog.mb_main = await safeUpdateLinks(T.mealboxes, mbMainRecs, MB_MAIN_CANDIDATES);
    if (mbSideRecs.length) writeLog.mb_side = await safeUpdateLinks(T.mealboxes, mbSideRecs, MB_SIDE_CANDIDATES);

    // 5.2 Order Lines: extras → Item
    if (olIds.length) {
      const olItemRecs = [];
      let k = 0;
      extras.forEach(x => {
        if (x?.itemId && Number(x?.qty) > 0) {
          const id = olIds[k++];
          olItemRecs.push({ id, fields: { [OL_ITEM_FIELD]: [ x.itemId ] } });
        }
      });
      if (olItemRecs.length) writeLog.ol_item = await safeUpdateLinks(T.orderlines, olItemRecs, OL_ITEM_CANDIDATES);
    }

    // 6) (опционально) записать разбивку в РЕДАКТИРУЕМЫЕ числовые поля, если заданы через ENV
    if (MB_QTY_STD_INPUT || MB_QTY_UPS_INPUT) {
      const qtyRecs = [];
      mbIds.forEach((id, i) => {
        const b = boxes[i] || {};
        const fields = {};
        if (MB_QTY_STD_INPUT && b.qtyStandard != null) fields[MB_QTY_STD_INPUT] = Number(b.qtyStandard||0);
        if (MB_QTY_UPS_INPUT && b.qtyUpsized  != null) fields[MB_QTY_UPS_INPUT] = Number(b.qtyUpsized ||0);
        if (Object.keys(fields).length) qtyRecs.push({ id, fields });
      });
      writeLog.qty_inputs = await tryUpdateNumbers(T.mealboxes, qtyRecs);
    }

    // 7) read-back
    await sleep(200);
    const rOrd = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [ORDERS_OL_FIELD, ORDERS_MB_FIELD],
    });
    const order = (rOrd.records && rOrd.records[0]) || null;

    const rMB2 = mbIds.length ? await aGet(T.mealboxes, { filterByFormula: orByIds(mbIds) }) : { records: [] };
    const rOL2 = olIds.length ? await aGet(T.orderlines, { filterByFormula: orByIds(olIds) }) : { records: [] };

    return res.status(200).json({
      ok: true,
      orderId,
      ids: { mealBoxes: mbIds, orderLines: olIds },
      writeLog,
      readBack: { order, mealBoxes: rMB2.records || [], orderLines: rOL2.records || [] }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
