// /lib/handlers/hr_orders.js
// HR: список заказов на дату (mode=list) и карточка одного сотрудника (mode=single)
// Приведено к точным именам полей из структуры Airtable.

const { json, withRateLimit, atGet, one, TABLE, F } = require('../../lib/utils');

// ====== Жёсткая привязка к именам полей из структуры ======
const ORDERS      = TABLE.ORDERS     || 'Orders';
const EMPLOYEES   = TABLE.EMPLOYEES  || 'Employees';
const MEALBOXES   = TABLE.MEALBOXES  || 'Meal Boxes';
const ORDERLINES  = TABLE.ORDERLINES || 'Order Lines';
const ORGS        = TABLE.ORGS       || 'Organizations';

// Employees
const EMP_FULLNAME   = 'FullName';
const EMP_ORG_LOOKUP = 'OrgID (from Organization)';
const EMP_TOKEN      = 'Order Token';
const EMP_STATUS     = 'Status';
const EMP_ROLE       = 'Role';

// Orders
const ORDER_NO       = 'Order No';
const ORDER_DATE     = 'Order Date';
const ORDER_DATE_ISO = 'OrderDateISO';
const ORDER_TYPE     = 'Order Type';
const ORDER_EMP      = 'Employee';
const ORDER_ORG_LINK = 'Org';
const ORDER_STATUS   = 'Status';
const ORDER_MB_LINK  = 'Meal Boxes';
const ORDER_OL_LINK  = 'Order Lines';

// Meal Boxes
const MB_MAIN_NAME   = 'Main Name';
const MB_SIDE_NAME   = 'Side Name';
const MB_QTY         = 'Quantity';

// Order Lines
const OL_ITEM_NAME   = 'Item Name';
const OL_QTY         = 'Quantity';

// Utils
const lower = (s) => String(s || '').toLowerCase();
const isCancelled = (st) => {
  const s = lower(st);
  return s === 'cancelled' || s === 'canceled' || s === 'deleted';
};

function mealBoxToText(mbRec) {
  const f = mbRec?.fields || {};
  const main = f[MB_MAIN_NAME] || '';
  const side = f[MB_SIDE_NAME] || '';
  if (main && side) return `${main} + ${side}`;
  if (main)          return `${main}`;
  if (side)          return `${side}`;
  return '';
}

async function getEmployeeById(id, fields = []) {
  const r = await atGet(EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${id}'`,
    "fields[]": fields,
    maxRecords: 1,
    pageSize: 1
  });
  return one(r.records);
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = (url.searchParams.get('mode') || 'list').toLowerCase();

  const requesterID = url.searchParams.get('employeeID');
  const org         = url.searchParams.get('org');
  const token       = url.searchParams.get('token');
  const date        = url.searchParams.get('date');
  const forEmpID    = url.searchParams.get('forEmployeeID'); // для single от HR

  if (!requesterID || !org || !token || !date) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // 0) валидируем вызывающего
  const who = await getEmployeeById(requesterID, [EMP_ORG_LOOKUP, EMP_TOKEN, EMP_ROLE, EMP_FULLNAME, EMP_STATUS]);
  if (!who) return json(res, 404, { error: 'employee not found' });

  const whoOrg = Array.isArray(who.fields[EMP_ORG_LOOKUP]) ? who.fields[EMP_ORG_LOOKUP][0] : who.fields[EMP_ORG_LOOKUP];
  if (whoOrg !== org) return json(res, 403, { error: 'org mismatch' });
  if (who.fields[EMP_TOKEN] !== token) return json(res, 403, { error: 'invalid token' });
  if (isCancelled(who.fields[EMP_STATUS])) return json(res, 403, { error: 'employee not active' });

  const isHR = String(who.fields[EMP_ROLE] || '').toUpperCase().includes('HR');

  // Формула для активных employee-заказов на дату (по OrderDateISO)
  const baseFilter = `AND(
    {${ORDER_DATE_ISO}}='${date}',
    NOT(OR(
      LOWER({${ORDER_STATUS}})='cancelled',
      LOWER({${ORDER_STATUS}})='canceled',
      LOWER({${ORDER_STATUS}})='deleted'
    )),
    {${ORDER_TYPE}}='Employee'
  )`;

  // ==================== LIST ====================
  if (mode === 'list') {
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    // 1) Все employee-заказы на дату
    const ordersResp = await atGet(ORDERS, {
      filterByFormula: baseFilter,
      "fields[]": [ORDER_EMP, ORDER_DATE, ORDER_STATUS, ORDER_MB_LINK, ORDER_OL_LINK, ORDER_ORG_LINK],
      pageSize: 100
    });
    let orders = ordersResp.records || [];
    if (!orders.length) return json(res, 200, { ok: true, items: [] });

    // 2) Оставим только заказы нужной организации (link Org -> Organizations)
    orders = orders.filter(o => {
      const link = o.fields?.[ORDER_ORG_LINK];
      const orgId = Array.isArray(link) ? link[0] : link;
      return orgId === org || orgId === whoOrg; // у тебя org — это код; в Orders.Org может быть именно код или ссылка; utils часто маппит код — оставлю оба варианта
    });

    if (!orders.length) return json(res, 200, { ok: true, items: [] });

    // 3) Соберём id сотрудников из заказов
    const empIds = Array.from(new Set(
      orders.flatMap(o => o.fields?.[ORDER_EMP] || [])
    ));

    // 4) Подтянем ФИО и проверим Org
    const empMap = new Map(); // id -> {name, ok}
    for (let i = 0; i < empIds.length; i += 50) {
      const chunk = empIds.slice(i, i + 50);
      const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const e = await atGet(EMPLOYEES, {
        filterByFormula: or,
        "fields[]": [EMP_FULLNAME, EMP_ORG_LOOKUP],
        pageSize: 50
      });
      (e.records || []).forEach(r => {
        const orgId = Array.isArray(r.fields[EMP_ORG_LOOKUP]) ? r.fields[EMP_ORG_LOOKUP][0] : r.fields[EMP_ORG_LOOKUP];
        empMap.set(r.id, { name: r.fields[EMP_FULLNAME] || '', ok: (orgId === org || orgId === whoOrg) });
      });
    }

    // 5) Соберём ссылки на MB и OL
    const allMB = [];
    const allOL = [];
    for (const o of orders) {
      allMB.push(...(o.fields?.[ORDER_MB_LINK] || []));
      allOL.push(...(o.fields?.[ORDER_OL_LINK] || []));
    }

    // 6) Подтянем Meal Boxes
    const mbMap = new Map(); // id -> record
    if (allMB.length) {
      for (let i = 0; i < allMB.length; i += 50) {
        const chunk = allMB.slice(i, i + 50);
        const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const mb = await atGet(MEALBOXES, {
          filterByFormula: or,
          "fields[]": [MB_MAIN_NAME, MB_SIDE_NAME, MB_QTY],
          pageSize: 50
        });
        (mb.records || []).forEach(r => mbMap.set(r.id, r));
      }
    }

    // 7) Подтянем Order Lines
    const olMap = new Map(); // id -> {name, qty}
    if (allOL.length) {
      for (let i = 0; i < allOL.length; i += 50) {
        const chunk = allOL.slice(i, i + 50);
        const or = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const ol = await atGet(ORDERLINES, {
          filterByFormula: or,
          "fields[]": [OL_ITEM_NAME, OL_QTY],
          pageSize: 50
        });
        (ol.records || []).forEach(r => {
          olMap.set(r.id, { name: r.fields?.[OL_ITEM_NAME] || '', qty: Number(r.fields?.[OL_QTY] || 0) || 0 });
        });
      }
    }

    // 8) Сборка списка
    const items = [];
    for (const o of orders) {
      const empId = (o.fields?.[ORDER_EMP] || [])[0];
      if (!empId) continue;
      const info = empMap.get(empId);
      if (!info || !info.ok) continue;

      // meal box — берём первый
      const mbIds = o.fields?.[ORDER_MB_LINK] || [];
      const mbText = mbIds.length ? mealBoxToText(mbMap.get(mbIds[0])) : '';

      // extras — первые две
      const olIds = (o.fields?.[ORDER_OL_LINK] || []).slice(0, 2);
      const extraNames = olIds
        .map(id => olMap.get(id))
        .filter(Boolean)
        .map(x => x.name)
        .filter(Boolean);

      items.push({
        employeeId: empId,
        fullName: info.name || '',
        date,
        orderId: o.id,
        mealBox: mbText,
        extra1: extraNames[0] || '',
        extra2: extraNames[1] || ''
      });
    }

    items.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ru'));
    return json(res, 200, { ok: true, items });
  }

  // ==================== SINGLE ====================
  // цель — показать модалку по одному сотруднику (текущему или выбранному HR)
  let targetEmpId = requesterID;
  let targetName  = who.fields[EMP_FULLNAME] || '';
  if (forEmpID && forEmpID !== requesterID) {
    if (!isHR) return json(res, 403, { error: 'only HR can query on-behalf' });
    const te = await getEmployeeById(forEmpID, [EMP_ORG_LOOKUP, EMP_FULLNAME]);
    if (!te) return json(res, 404, { error: 'target employee not found' });
    const teOrg = Array.isArray(te.fields[EMP_ORG_LOOKUP]) ? te.fields[EMP_ORG_LOOKUP][0] : te.fields[EMP_ORG_LOOKUP];
    if (!(teOrg === org || teOrg === whoOrg)) return json(res, 403, { error: 'target in another org' });
    targetEmpId = te.id;
    targetName  = te.fields[EMP_FULLNAME] || '';
  }

  // Заказ конкретного сотрудника на дату
  const ordersResp = await atGet(ORDERS, {
    filterByFormula: `AND(
      {${ORDER_DATE_ISO}}='${date}',
      {${ORDER_TYPE}}='Employee',
      NOT(OR(
        LOWER({${ORDER_STATUS}})='cancelled',
        LOWER({${ORDER_STATUS}})='canceled',
        LOWER({${ORDER_STATUS}})='deleted'
      )),
      {${ORDER_EMP}}='${targetEmpId}'
    )`,
    "fields[]": [ORDER_NO, ORDER_EMP, ORDER_STATUS, ORDER_DATE, ORDER_MB_LINK, ORDER_OL_LINK, ORDER_ORG_LINK],
    maxRecords: 1,
    pageSize: 1
  });

  const order = one(ordersResp.records);
  if (!order) return json(res, 200, { ok: true, summary: null, order: null });

  // Meal Box(первый) + Extras(первые две)
  const mbIds = order.fields?.[ORDER_MB_LINK] || [];
  const olIds = (order.fields?.[ORDER_OL_LINK] || []).slice(0, 2);

  const [mbResp, olResp] = await Promise.all([
    mbIds.length
      ? atGet(MEALBOXES,  { filterByFormula: `OR(${mbIds.map(id => `RECORD_ID()='${id}'`).join(',')})`, "fields[]": [MB_MAIN_NAME, MB_SIDE_NAME, MB_QTY] })
      : { records: [] },
    olIds.length
      ? atGet(ORDERLINES, { filterByFormula: `OR(${olIds.map(id => `RECORD_ID()='${id}'`).join(',')})`, "fields[]": [OL_ITEM_NAME, OL_QTY] })
      : { records: [] }
  ]);

  const mbText = mbResp.records?.length ? mealBoxToText(mbResp.records[0]) : '';
  const extras = (olResp.records || [])
    .map(r => r.fields?.[OL_ITEM_NAME])
    .filter(Boolean);

  const summary = {
    fullName: targetName,
    date,
    mealBox: mbText,
    extra1: extras[0] || '',
    extra2: extras[1] || '',
    orderId: order.id
  };

  return json(res, 200, {
    ok: true,
    summary,
    order,
    mealBoxes: mbResp.records || [],
    orderLines: olResp.records || []
  });
}, { windowMs: 4000, max: 15 });
