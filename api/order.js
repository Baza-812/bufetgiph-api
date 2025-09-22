// api/order.js
//
// Создаёт ЕДИНИЧНЫЙ заказ (сотрудник).
// Тело запроса (JSON):
// {
//   "employeeID": "recXXXX",            // RECORD_ID() из Employees
//   "org": "org120",                    // код организации
//   "token": "........",                // Order Token из Employees
//   "date": "2025-09-22",               // дата меню (YYYY-MM-DD)
//   "included": {
//     "mainId": "recMenuMain",          // Menu record id (Main)
//     "sideId": "recMenuSide",          // Menu record id (Side) - опционально
//     "extras": ["recMenu1","recMenu2"] // до 2 доп.позиций (Menu record id)
//   }
// }
//
// Возвращает ok, orderId, созданные дети и readBack.

import { aGet, aPost, aPatch, T, fstr, cors } from './_lib/air.js';

// --- НАЗВАНИЯ ПОЛЕЙ (ENV → дефолты). В ENV можно писать с _ вместо пробелов ---
const deU = (s) => (s || '').replace(/_/g, ' ');

const F = {
  // Orders
  orderEmployee: deU(process.env.ORDER_EMP_FIELD) || 'Employee',
  orderMBLink:   deU(process.env.ORDER_MB_LINK_FIELD) || 'Meal Boxes',
  orderOLLink:   deU(process.env.ORDER_OL_LINK_FIELD) || 'Order Lines',

  // Meal Boxes
  mbOrder: deU(process.env.MB_ORDER_FIELD) || 'Order',
  mbMain:  deU(process.env.MB_MAIN_FIELD)  || 'Main (Menu Item)',
  mbSide:  deU(process.env.MB_SIDE_FIELD)  || 'Side (Menu Item)',
  mbQty:   deU(process.env.MB_QTY_FIELD)   || 'Quantity',
  mbType:  deU(process.env.MB_TYPE_FIELD)  || 'Line Type',

  // Order Lines
  olOrder: deU(process.env.OL_ORDER_FIELD) || 'Order',
  olItem:  deU(process.env.OL_ITEM_FIELD)  || 'Item (Menu Item)',
  olQty:   deU(process.env.OL_QTY_FIELD)   || 'Quantity',
  olType:  deU(process.env.OL_TYPE_FIELD)  || 'Line Type',

  // Employees (проверки)
  empOrgLookup: deU(process.env.EMP_ORG_LOOKUP) || 'OrgID (from Organization)',
  empToken:     deU(process.env.EMP_TOKEN_FIELD) || 'Order Token',
  empStatus:    deU(process.env.EMP_STATUS_FIELD) || 'Status'
};

// --- Утилиты ---------------------------------------------------------------
const bad = (res, code, msg) => res.status(code).json({ error: msg });

const oneOrNull = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

const arrify = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));

// проверка: дата доступна (в меню есть позиции на эту дату)
async function assertDateIsAvailable(date, org) {
  // Фильтр только по дате; если нужно — добавишь доп.условия по доступу/OrgAccess
  const r = await aGet(T.menu, {
    filterByFormula: `IS_SAME({Date}, DATETIME_PARSE('${fstr(date)}'), 'day')`,
    maxRecords: 1,
    'fields[]': ['Date']
  });
  return (r.records || []).length > 0;
}

// --- Основной обработчик ---------------------------------------------------
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'POST only');

  try {
    const body = req.body || {};
    const { employeeID, org, token, date, included } = body;

    if (!employeeID || !org || !token || !date) {
      return bad(res, 400, 'employeeID, org, token, date are required');
    }

    // 1) Сотрудник и валидации
    const empResp = await aGet(T.employees, {
      filterByFormula: `RECORD_ID()='${fstr(employeeID)}'`,
      'fields[]': [F.empOrgLookup, F.empToken, F.empStatus]
    });
    const emp = oneOrNull(empResp.records);
    if (!emp) return bad(res, 404, 'employee not found');

    const empFields = emp.fields || {};
    const empOrg = oneOrNull(empFields[F.empOrgLookup]) || empFields[F.empOrgLookup] || null;
    if (empOrg !== org) return bad(res, 403, 'employee not allowed (org mismatch)');

    const empTok = empFields[F.empToken];
    if (!empTok || empTok !== token) return bad(res, 403, 'invalid token');

    // (опц.) проверка статуса
    const st = empFields[F.empStatus];
    if (st && String(st).toLowerCase() !== 'active') {
      return bad(res, 403, 'employee not active');
    }

    // 2) Дата доступна?
    const okDate = await assertDateIsAvailable(date, org);
    if (!okDate) return bad(res, 400, 'date is not available for this org');

    // 3) Создаём заказ (КЛЮЧЕВОЕ: проставляем Employee линк)
    const orderFields = {
      'Order Date': date,
      'Order Type': 'Employee',
      [F.orderEmployee]: [emp.id] // ← линк на сотрудника
    };

    const orderResp = await aPost(T.orders, {
      records: [{ fields: orderFields }],
      typecast: true
    });
    const orderRec = oneOrNull(orderResp.records);
    if (!orderRec) return bad(res, 500, 'order create failed');
    const orderId = orderRec.id;

    // 4) Записываем детей
    const writeLog = { mb_main: {}, mb_side: {}, ol_item: {}, qty_inputs: {} };

    // Meal Box (main + side)
    const mbRecords = [];
    if (included && (included.mainId || included.sideId)) {
      const mbFields = {
        [F.mbOrder]: [orderId],
        [F.mbQty]: 1,
        [F.mbType]: 'Included'
      };
      if (included.mainId) mbFields[F.mbMain] = [{ id: included.mainId }];
      if (included.sideId) mbFields[F.mbSide] = [{ id: included.sideId }];

      const mbResp = await aPost(T.mealboxes, {
        records: [{ fields: mbFields }],
        typecast: true
      });
      (mbResp.records || []).forEach(r => mbRecords.push(r));
      writeLog.mb_main.ok = [F.mbMain];
      if (included.sideId) writeLog.mb_side.ok = [F.mbSide];
    }

    // Order Lines (extras)
    const olRecords = [];
    const extras = (included && included.extras) ? included.extras.slice(0, 2) : [];
    if (extras.length) {
      const toCreate = extras.map(id => ({
        fields: {
          [F.olOrder]: [orderId],
          [F.olItem]: [{ id }],
          [F.olQty]: 1,
          [F.olType]: 'Included'
        }
      }));
      const olResp = await aPost(T.orderlines, {
        records: toCreate,
        typecast: true
      });
      (olResp.records || []).forEach(r => olRecords.push(r));
      writeLog.ol_item.ok = [F.olItem];
    }

    // 5) (подстраховка) Пролинкуем детей с родителем из стороны Orders
    const patchFields = {};
    if (mbRecords.length) patchFields[F.orderMBLink] = mbRecords.map(r => r.id);
    if (olRecords.length) patchFields[F.orderOLLink] = olRecords.map(r => r.id);
    if (Object.keys(patchFields).length) {
      await aPatch(T.orders, {
        records: [{ id: orderId, fields: patchFields }],
        typecast: true
      });
    }

    // 6) ReadBack для контроля
    const readOrder = await aGet(T.orders, {
      filterByFormula: `RECORD_ID()='${fstr(orderId)}'`,
      'fields[]': [F.orderMBLink, F.orderOLLink, 'Order Date', 'Order Type', F.orderEmployee]
    });
    const readOL = olRecords.length
      ? await aGet(T.orderlines, {
          filterByFormula: `OR(${olRecords.map(r => `RECORD_ID()='${fstr(r.id)}'`).join(',')})`
        })
      : { records: [] };
    const readMB = mbRecords.length
      ? await aGet(T.mealboxes, {
          filterByFormula: `OR(${mbRecords.map(r => `RECORD_ID()='${fstr(r.id)}'`).join(',')})`
        })
      : { records: [] };

    return res.status(200).json({
      ok: true,
      orderId,
      ids: {
        orderLines: olRecords.map(r => r.id),
        mealBoxes: mbRecords.map(r => r.id)
      },
      writeLog,
      readBack: {
        order: oneOrNull(readOrder.records) || null,
        orderLines: readOL.records || [],
        mealBoxes: readMB.records || []
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
