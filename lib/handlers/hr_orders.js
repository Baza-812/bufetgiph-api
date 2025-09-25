// lib/handlers/hr_orders.js
const { json, withRateLimit, atGet, one, TABLE, F } = require('../utils');

// Текст «Главное + Гарнир»
function mealBoxToText(mb) {
  const f = mb.fields || {};
  const main = Array.isArray(f[F.MB_MAIN_NAME]) ? f[F.MB_MAIN_NAME][0] : f[F.MB_MAIN_NAME];
  const side = Array.isArray(f[F.MB_SIDE_NAME]) ? f[F.MB_SIDE_NAME][0] : f[F.MB_SIDE_NAME];
  if (main && side) return `${main} + ${side}`;
  if (main) return `${main}`;
  if (side) return `${side}`;
  return '';
}

async function getEmployeeById(id, extraFields = []) {
  const resp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${id}'`,
    "fields[]": extraFields,
    maxRecords: 1
  });
  return one(resp.records);
}

// Только активные заказы по дате (без фильтра по Org — он ломает выборку, т.к. Org = Link)
function onlyActiveOrderFormula(date, typeFilter, employeeIdFilter) {
  const parts = [
    `DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}'`,
    `AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))`
  ];
  if (typeFilter) parts.push(`{${F.ORDER_TYPE}}='${typeFilter}'`);
  if (employeeIdFilter) {
    parts.push(`FIND('${employeeIdFilter}', ARRAYJOIN({${F.ORDER_EMPLOYEE}}&""))>0`);
  }
  return `AND(${parts.join(',')})`;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = (url.searchParams.get('mode') || 'list').toLowerCase();

  const requesterID = url.searchParams.get('employeeID'); // HR/Manager или сам сотрудник
  const org         = url.searchParams.get('org');
  const token       = url.searchParams.get('token');
  const date        = url.searchParams.get('date');       // YYYY-MM-DD
  const forEmpID    = url.searchParams.get('forEmployeeID'); // таргет-сотрудник (опц.)

  if (!requesterID || !org || !token || !date) {
    return json(res, 400, { error: 'employeeID, org, token, date required' });
  }

  // 1) Проверяем вызывающего
  const who = await getEmployeeById(requesterID, [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_ROLE, F.EMP_NAME]);
  if (!who) return json(res, 404, { error: 'employee not found' });
  const whoOrg = Array.isArray(who.fields[F.EMP_ORG_LOOKUP]) ? who.fields[F.EMP_ORG_LOOKUP][0] : who.fields[F.EMP_ORG_LOOKUP];
  if (whoOrg !== org)                     return json(res, 403, { error: 'org mismatch' });
  if (who.fields[F.EMP_TOKEN] !== token)  return json(res, 403, { error: 'invalid token' });

  const role   = String(who.fields[F.EMP_ROLE] || '').toUpperCase();
  const isHR   = role.includes('HR');
  const isPriv = isHR || role.includes('MANAGER'); // для кухни допускаем HR/Manager

  // === РЕЖИМ KITCHEN: агрегированная сводка (HR/Manager) ===
  if (mode === 'kitchen') {
    if (!isPriv) return json(res, 403, { error: 'HR/Manager role required' });

    // Берём все активные заказы на дату (Employee/Manager), без фильтра по Org
    const filter = `
      AND(
        DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${date}',
        AND(NOT({${F.ORDER_STATUS}}='Cancelled'), NOT({${F.ORDER_STATUS}}='Deleted'))
      )`;

    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: filter,
      "fields[]": [F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE, F.ORDER_TYPE],
      pageSize: 100
    });
    let orders = ordersResp.records || [];
    if (!orders.length) {
      return json(res, 200, { ok: true, date, org, totals: { boxes: [], extras: [], stats: { orders: 0, boxes: 0, extras: 0 } } });
    }

    // Фильтр по Org через Employees
    const empIds = Array.from(new Set(orders.flatMap(o => o.fields?.[F.ORDER_EMPLOYEE] || [])));
    const empOrgMap = new Map(); // id -> orgId
    if (empIds.length) {
      const chunks = [];
      for (let i = 0; i < empIds.length; i += 50) chunks.push(empIds.slice(i, i + 50));
      for (const ch of chunks) {
        const or = `OR(${ch.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const e = await atGet(TABLE.EMPLOYEES, { filterByFormula: or, "fields[]": [F.EMP_ORG_LOOKUP], pageSize: 50 });
        (e.records || []).forEach(r => {
          const f = r.fields || {};
          const orgId = Array.isArray(f[F.EMP_ORG_LOOKUP]) ? f[F.EMP_ORG_LOOKUP][0] : f[F.EMP_ORG_LOOKUP];
          empOrgMap.set(r.id, orgId || '');
        });
      }
    }
    orders = orders.filter(o => {
      const eid = (o.fields?.[F.ORDER_EMPLOYEE] || [])[0];
      return empOrgMap.get(eid) === org;
    });
    if (!orders.length) {
      return json(res, 200, { ok: true, date, org, totals: { boxes: [], extras: [], stats: { orders: 0, boxes: 0, extras: 0 } } });
    }

    const orderIds = orders.map(o => o.id);

    // Тянем Meal Boxes/Order Lines чанками
    const mbAll = [];
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const or = `OR(${chunk.map(id => `{${F.MB_ORDER}}='${id}'`).join(',')})`;
      const r = await atGet(TABLE.MEALBOXES, {
        filterByFormula: or,
        "fields[]": [F.MB_MAIN, F.MB_SIDE, F.MB_MAIN_NAME, F.MB_SIDE_NAME, F.MB_QTY, 'Qty — Standard', 'Qty — Upsized', 'Portion Type'],
        pageSize: 100
      });
      mbAll.push(...(r.records || []));
    }

    const olAll = [];
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const or = `OR(${chunk.map(id => `{${F.OL_ORDER}}='${id}'`).join(',')})`;
      const r = await atGet(TABLE.ORDERLINES, {
        filterByFormula: or,
        "fields[]": [F.OL_ITEM, F.OL_NAME, F.OL_QTY],
        pageSize: 100
      });
      olAll.push(...(r.records || []));
    }

    // Агрегация коробок
    const aggBoxes = new Map(); let totalBoxes = 0;
    for (const mb of mbAll) {
      const f = mb.fields || {};
      const mainName = Array.isArray(f[F.MB_MAIN_NAME]) ? f[F.MB_MAIN_NAME][0] : f[F.MB_MAIN_NAME] || '';
      const sideName = Array.isArray(f[F.MB_SIDE_NAME]) ? f[F.MB_SIDE_NAME][0] : f[F.MB_SIDE_NAME] || '';
      const qty  = Number(f[F.MB_QTY] || 0);
      const qStd = Number(f['Qty — Standard'] || 0);
      const qUp  = Number(f['Qty — Upsized'] || 0);
      const portionType = f['Portion Type'];
      if (!qty) continue;

      const key = `${mainName}|${sideName}`;
      if (!aggBoxes.has(key)) aggBoxes.set(key, { mainName, sideName, qty: 0, qtyStandard: 0, qtyUpsized: 0 });
      const row = aggBoxes.get(key);
      row.qty += qty;
      if (qStd || qUp) { row.qtyStandard += qStd; row.qtyUpsized += qUp; }
      else {
        if (String(portionType || '').toLowerCase().includes('up')) row.qtyUpsized += qty;
        else row.qtyStandard += qty;
      }
      totalBoxes += qty;
    }

    // Агрегация экстр
    const aggExtras = new Map(); let totalExtras = 0;
    for (const ol of olAll) {
      const f = ol.fields || {};
      const itemName = Array.isArray(f[F.OL_NAME]) ? f[F.OL_NAME][0] : f[F.OL_NAME] || '';
      const qty = Number(f[F.OL_QTY] || 0);
      if (!itemName || !qty) continue;
      if (!aggExtras.has(itemName)) aggExtras.set(itemName, { itemName, qty: 0 });
      aggExtras.get(itemName).qty += qty;
      totalExtras += qty;
    }

    const boxes  = Array.from(aggBoxes.values()).sort((a,b) => (a.mainName||'').localeCompare(b.mainName||'', 'ru') || (a.sideName||'').localeCompare(b.sideName||'', 'ru'));
    const extras = Array.from(aggExtras.values()).sort((a,b) => (a.itemName||'').localeCompare(b.itemName||'', 'ru'));

    return json(res, 200, { ok: true, date, org, totals: { boxes, extras, stats: { orders: orders.length, boxes: totalBoxes, extras: totalExtras } } });
  }

  // === РЕЖИМ LIST: список активных (HR) по дате ===
  if (mode === 'list') {
    if (!isHR) return json(res, 403, { error: 'HR role required' });

    const filter = onlyActiveOrderFormula(date, 'Employee', null);
    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: filter,
      "fields[]": [F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE],
      pageSize: 100
    });
    let orders = ordersResp.records || [];
    if (!orders.length) return json(res, 200, { ok: true, count: 0, items: [] });

    // Подтягиваем сотрудников: ФИО и OrgID (from Organization)
    const empIds = Array.from(new Set(orders.flatMap(o => o.fields?.[F.ORDER_EMPLOYEE] || [])));
    const empMap = new Map(); // id -> { name, orgId }
    if (empIds.length) {
      const chunks = [];
      for (let i = 0; i < empIds.length; i += 50) chunks.push(empIds.slice(i, i + 50));
      for (const ch of chunks) {
        const or = `OR(${ch.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        const e = await atGet(TABLE.EMPLOYEES, { filterByFormula: or, "fields[]": [F.EMP_NAME, F.EMP_ORG_LOOKUP], pageSize: 50 });
        (e.records || []).forEach(r => {
          const f = r.fields || {};
          const orgId = Array.isArray(f[F.EMP_ORG_LOOKUP]) ? f[F.EMP_ORG_LOOKUP][0] : f[F.EMP_ORG_LOOKUP];
          empMap.set(r.id, { name: f[F.EMP_NAME] || '', orgId: orgId || '' });
        });
      }
    }

    // Фильтруем по своей орг
    orders = orders.filter(o => {
      const eid = (o.fields?.[F.ORDER_EMPLOYEE] || [])[0];
      const emp = empMap.get(eid);
      return emp && emp.orgId === org;
    });
    if (!orders.length) return json(res, 200, { ok: true, count: 0, items: [] });

    // Для каждого заказа соберём summary
    const items = [];
    for (const o of orders) {
      const orderId = o.id;
      const [mb, ol] = await Promise.all([
        atGet(TABLE.MEALBOXES,  { filterByFormula: `{${F.MB_ORDER}}='${orderId}'`, "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME] }),
        atGet(TABLE.ORDERLINES, { filterByFormula: `{${F.OL_ORDER}}='${orderId}'`, "fields[]": [F.OL_NAME] })
      ]);

      const eid = (o.fields?.[F.ORDER_EMPLOYEE] || [])[0];
      const emp = empMap.get(eid);
      const fullName = emp?.name || '';

      const mealBox  = (mb.records && mb.records[0]) ? mealBoxToText(mb.records[0]) : '';
      const extras   = (ol.records || []).map(r => {
        const nm = r.fields?.[F.OL_NAME];
        return Array.isArray(nm) ? nm[0] : (nm || '');
      }).filter(Boolean).slice(0, 2);

      items.push({ fullName, date, mealBox, extra1: extras[0] || '', extra2: extras[1] || '', orderId });
    }

    items.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ru'));
    return json(res, 200, { ok: true, count: items.length, items });
  }

  // === РЕЖИМ SINGLE: один заказ (HR по сотруднику или сам сотрудник) ===
  let targetEmpId = requesterID;
  let targetName  = who.fields[F.EMP_NAME] || '';
  if (forEmpID && forEmpID !== requesterID) {
    if (!isHR) return json(res, 403, { error: 'only HR can query on-behalf' });
    const te = await getEmployeeById(forEmpID, [F.EMP_ORG_LOOKUP, F.EMP_NAME]);
    if (!te) return json(res, 404, { error: 'target employee not found' });
    const teOrg = Array.isArray(te.fields[F.EMP_ORG_LOOKUP]) ? te.fields[F.EMP_ORG_LOOKUP][0] : te.fields[F.EMP_ORG_LOOKUP];
    if (teOrg !== org) return json(res, 403, { error: 'target in another org' });
    targetEmpId = te.id;
    targetName  = te.fields[F.EMP_NAME] || '';
  }

  const singleFilter = onlyActiveOrderFormula(date, 'Employee', targetEmpId);
  const orderResp = await atGet(TABLE.ORDERS, {
    filterByFormula: singleFilter,
    "fields[]": [F.ORDER_EMPLOYEE, F.ORDER_STATUS, F.ORDER_DATE],
    maxRecords: 1
  });
  const order = one(orderResp.records);
  if (!order) return json(res, 200, { ok: true, summary: null, order: null });

  const orderId = order.id;
  const [mb, ol] = await Promise.all([
    atGet(TABLE.MEALBOXES,  { filterByFormula: `{${F.MB_ORDER}}='${orderId}'`, "fields[]": [F.MB_MAIN_NAME, F.MB_SIDE_NAME] }),
    atGet(TABLE.ORDERLINES, { filterByFormula: `{${F.OL_ORDER}}='${orderId}'`, "fields[]": [F.OL_NAME] })
  ]);

  const mealBox = (mb.records && mb.records[0]) ? mealBoxToText(mb.records[0]) : '';
  const extras = (ol.records || []).map(r => {
    const nm = r.fields?.[F.OL_NAME];
    return Array.isArray(nm) ? nm[0] : (nm || '');
  }).filter(Boolean).slice(0, 2);

  const summary = { fullName: targetName, date, mealBox, extra1: extras[0] || '', extra2: extras[1] || '', orderId };

  return json(res, 200, { ok: true, summary, order, mealBoxes: mb.records || [], orderLines: ol.records || [] });
}, { windowMs: 4000, max: 15 });
