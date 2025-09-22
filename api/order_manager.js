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

    // 1) создаём заказ
    const orderResp = await aCreate(T.orders, [{
      'Order Date': date,
      'Order Type': ORDER_TYPE_MANAGER,
      'Status'    : STATUS_NEW,
      'Employee'  : [{ id: employeeID }],
    }]);
    const orderId = orderResp.records[0].id;

    // 2) создаём Meal Boxes пачкой
    const mbPayload = boxes.map(b => {
      const qtyS = Math.max(0, Number(b.qtyStandard||0));
      const qtyU = Math.max(0, Number(b.qtyUpsized||0));
      const qty  = qtyS + qtyU;
      return {
        'Quantity'       : qty || 0,
        'Line Type'      : LINE_INCLUDED,
        'Qty — Standard' : qtyS,
        'Qty — Upsized'  : qtyU,
      };
    });
    const rMB = await aCreate(T.mealboxes, mbPayload);
    const mbIds = (rMB.records||[]).map(r=>r.id);

    // 3) создаём Order Lines по extras (если есть)
    let olIds = [];
    if (Array.isArray(extras) && extras.length) {
      const olPayload = extras
        .filter(x => x?.itemId && Number(x?.qty) > 0)
        .map(x => ({
          'Quantity' : Number(x.qty),
          'Line Type': LINE_INCLUDED,
        }));
      if (olPayload.length) {
        const rOL = await aCreate(T.orderlines, olPayload);
        olIds = (rOL.records||[]).map(r=>r.id);
      }
    }

    await sleep(150);

    // 4) пришиваем детей к заказу
    await aUpdate(T.orders, [{
      id: orderId,
      fields: {
        [ORDERS_MB_FIELD]: mbIds,
        [ORDERS_OL_FIELD]: olIds,
      }
    }], true);

    await sleep(150);

    // 5) проставляем ссылки на меню — МАССИВАМИ СТРОК
    // 5.1 Meal Boxes: main/side для каждой записи по той же позиции boxes[i]
    const writeLog = { mb_main: {}, mb_side: {}, ol_item: {} };

    const mbMainRecs = [];
    const mbSideRecs = [];
    mbIds.forEach((id, i) => {
      const b = boxes[i] || {};
      if (b.mainId) mbMainRecs.push({ id, fields: { [MB_MAIN_FIELD]: [ b.mainId ] } });
      if (b.sideId) mbSideRecs.push({ id, fields: { [MB_SIDE_FIELD]: [ b.sideId ] } });
    });

    async function safeUpdate(table, records, fieldNames) {
      const tried = []; const ok = [];
      for (const fname of fieldNames) {
        const chunk = records
          .map(r => {
            const v = r.fields?.[fname];
            const good = Array.isArray(v) && v.length && typeof v[0] === 'string';
            return good ? { id: r.id, fields: { [fname]: v } } : null;
          })
          .filter(Boolean);
        tried.push({ fname, used: chunk.length });
        if (!chunk.length) continue;
        try {
          await aUpdate(table, chunk, true);
          ok.push(fname);
        } catch (e) {
          const msg = (e?.message || '').toString();
          if (!/UNKNOWN_FIELD_NAME/i.test(msg)) throw e;
        }
      }
      return { tried, ok };
    }

    if (mbMainRecs.length) writeLog.mb_main = await safeUpdate(T.mealboxes, mbMainRecs, MB_MAIN_CANDIDATES);
    if (mbSideRecs.length) writeLog.mb_side = await safeUpdate(T.mealboxes, mbSideRecs, MB_SIDE_CANDIDATES);

    // 5.2 Order Lines: itemId по extras — позиционно, только для тех, у кого qty > 0
    if (olIds.length) {
      const olItemRecs = [];
      let k = 0;
      extras.forEach(x => {
        if (x?.itemId && Number(x?.qty) > 0) {
          const id = olIds[k++];
          olItemRecs.push({ id, fields: { [OL_ITEM_FIELD]: [ x.itemId ] } });
        }
      });
      if (olItemRecs.length) writeLog.ol_item = await safeUpdate(T.orderlines, olItemRecs, OL_ITEM_CANDIDATES);
    }

    // 6) read-back
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
