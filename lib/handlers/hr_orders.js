// /lib/handlers/hr_orders.js
const { json, withRateLimit, atGet, listAll, one, TABLE, F } = require('../../lib/utils');

// --- helpers ------------------------------------------------------

function fld(nameConst, fallback) {
  // Берём имя поля из констант F, иначе фолбэк
  return (F && F[nameConst]) || fallback;
}

function mealBoxToText(mb) {
  const f = mb?.fields || {};
  const main = Array.isArray(f[F.MB_MAIN_NAME]) ? f[F.MB_MAIN_NAME][0] : f[F.MB_MAIN_NAME];
  const side = Array.isArray(f[F.MB_SIDE_NAME]) ? f[F.MB_SIDE_NAME][0] : f[F.MB_SIDE_NAME];
  if (main && side) return `${main} + ${side}`;
  if (main) return `${main}`;
  if (side) return `${side}`;
  return '';
}

// Формула поиска ОДНОГО активного заказа сотрудника на конкретную дату
function singleActiveOrderFormula(dateIso, employeeId, typeFilter) {
  const F_DATE       = fld('ORDER_DATE',       'Order Date');
  const F_DATE_ISO   = fld('ORDER_DATE_ISO',   'OrderDateISO');
  const F_STATUS     = fld('ORDER_STATUS',     'Status');
  const F_EMPLOYEE   = fld('ORDER_EMPLOYEE',   'Employee');
  const F_ORDER_TYPE = fld('ORDER_TYPE',       'Order Type');

  const parts = [
    // Дата: ISO-строка ИЛИ форматирование datetime-поля
    `OR({${F_DATE_ISO}}='${dateIso}', DATETIME_FORMAT({${F_DATE}}, 'YYYY-MM-DD')='${dateIso}')`,
    // Сотрудник: link-поле → ищем recId в строковом представлении массива
    `FIND('${employeeId}', ARRAYJOIN({${F_EMPLOYEE}}))`,
    // Только активные
    `AND(NOT({${F_STATUS}}='Cancelled'), NOT({${F_STATUS}}='Deleted'))`,
  ];
  if (typeFilter) parts.push(`{${F_ORDER_TYPE}}='${typeFilter}'`);
  return `AND(${parts.join(',')})`;
}

// --- handler ------------------------------------------------------

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = (url.searchParams.get('mode') || 'single').toLowerCase();

  const requesterID = url.searchParams.get('employeeID');
  const org   = url.searchParams.get('org');
  const token = url.searchParams.get('token');
  const date  = url.searchParams.get('date'); // YYYY-MM-DD

  if (!requesterID || !org || !token || !date) {
    return json(res, 400, { ok:false, error: 'employeeID, org, token, date required' });
  }

  // 1) Авторизация по сотруднику
  const F_EMP_ORG = fld('EMP_ORG_LOOKUP', 'OrgID');       // lookup/код организации у сотрудника
  const F_EMP_TOK = fld('EMP_TOKEN',      'Order Token'); // токен из Employees
  const F_EMP_NAME = fld('EMP_NAME',      'FullName');

  const meResp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${requesterID}'`,
    "fields[]": [F_EMP_ORG, F_EMP_TOK, F_EMP_NAME],
    maxRecords: 1,
  });
  const me = one(meResp.records);
  if (!me) return json(res, 404, { ok:false, error: 'employee not found' });

  const empOrg = Array.isArray(me.fields[F_EMP_ORG]) ? me.fields[F_EMP_ORG][0] : me.fields[F_EMP_ORG];
  if (empOrg !== org)                  return json(res, 403, { ok:false, error: 'org mismatch' });
  if (me.fields[F_EMP_TOK] !== token)  return json(res, 403, { ok:false, error: 'invalid token' });

  // 2) Только режим "single" нужен для модалки
  if (mode !== 'single') {
    return json(res, 400, { ok:false, error: 'unsupported mode; use mode=single' });
  }

  // 3) Находим один активный заказ на дату
  const filter = singleActiveOrderFormula(date, requesterID, null);
  const ordResp = await atGet(TABLE.ORDERS, {
    filterByFormula: filter,
    maxRecords: 1,
    pageSize: 1,
  });
  const order = one(ordResp.records);
  if (!order) {
    // Нет заказа — возвращаем пусто (UI покажет «не удалось…»)
    return json(res, 200, { ok:true, summary: null, order: null });
  }

  // 4) Пробуем подтянуть состав (Meal Box + допы) — "best effort".
  // Если вдруг не удастся — всё равно вернём summary с orderId,
  // чтобы кнопки «Отменить/Изменить» работали.
  let mealBoxText = '';
  let extra1 = '';
  let extra2 = '';

  try {
    const F_OL_ORDER   = fld('OL_ORDER',   'Order');     // link на заказ
    const F_OL_MB      = fld('OL_MEALBOX', 'Meal Box');  // link на meal box
    const F_OL_NAME    = fld('OL_NAME',    'Name');      // имя позиции / допа
    const F_MB_NAME    = fld('MB_NAME',    'Name');      // fallback, если нет main/side

    // все линии заказа
    const lines = await listAll(TABLE.ORDER_LINES, {
      filterByFormula: `FIND('${order.id}', ARRAYJOIN({${F_OL_ORDER}}))`,
      pageSize: 100,
    });

    // Meal Box (первая найденная строка с линком на MB)
    const mbLine = (lines || []).find(r => (r.fields || {})[F_OL_MB]);
    if (mbLine) {
      const mbId = Array.isArray(mbLine.fields[F_OL_MB]) ? mbLine.fields[F_OL_MB][0] : mbLine.fields[F_OL_MB];
      if (mbId) {
        const mbResp = await atGet(TABLE.MEAL_BOXES, {
          filterByFormula: `RECORD_ID()='${mbId}'`,
          "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME, F_MB_NAME],
          maxRecords: 1,
        });
        const mb = one(mbResp.records);
        mealBoxText = mealBoxToText(mb) || (mb?.fields?.[F_MB_NAME] || '');
      }
    }

    // Простейший сбор двух «допов» из остальных линий по имени
    const extras = (lines || [])
      .filter(r => r.id !== (mbLine && mbLine.id))
      .map(r => (r.fields || {})[F_OL_NAME])
      .filter(Boolean)
      .slice(0, 2);

    extra1 = extras[0] || '';
    extra2 = extras[1] || '';
  } catch (e) {
    // Молча продолжаем — для UI главное отдать orderId
  }

  const fullName = me.fields[F_EMP_NAME] || '';
  const summary = {
    fullName,
    date,
    mealBox: mealBoxText,
    extra1,
    extra2,
    orderId: order.id,
  };

  return json(res, 200, { ok:true, summary, order });
}, { windowMs: 4000, max: 20 });
