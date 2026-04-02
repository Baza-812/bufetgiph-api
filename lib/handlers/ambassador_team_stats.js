// lib/handlers/ambassador_team_stats.js
// GET /api/ambassador/team_stats?org=orgXXX&date=2026-03-20

const { json, atGet, one, TABLE, F } = require('../utils');

/**
 * Условие по дате доставки заказа.
 * Два варианта в OR: IS_SAME (как busy.js) и DATETIME_FORMAT (как findExistingEmployeeOrder в order.js) —
 * у разных типов поля «Order Date» в Airtable срабатывает не всегда один и тот же вариант.
 * Опционально FLD_ORDER_DATE_ISO — только если поле реально есть в базе.
 */
function dateCondOrders(dateISO) {
  const isoField = (process.env.FLD_ORDER_DATE_ISO || '').trim();
  const sameDay = `IS_SAME({${F.ORDER_DATE}}, '${dateISO}', 'day')`;
  const byFmt = `DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${dateISO}'`;
  let core = `OR(${sameDay}, ${byFmt})`;
  if (isoField) {
    core = `OR({${isoField}}='${dateISO}', ${core})`;
  }
  return core;
}

/** Связь Employee: SEARCH+ARRAYJOIN и прямое сравнение (для одиночной ссылки оба варианта бывают в базах). */
function employeeLinkMatchesFormula(fieldName, recordId) {
  const id = String(recordId).replace(/'/g, "\\'");
  const search = `SEARCH('${id}', ARRAYJOIN({${fieldName}})) > 0`;
  const direct = `{${fieldName}}='${id}'`;
  return `OR(${search}, ${direct})`;
}

function orderEmployeeInTeamSet(order, teamSet) {
  const raw = order.fields?.[F.ORDER_EMPLOYEE];
  if (Array.isArray(raw)) {
    return raw.some((id) => id && teamSet.has(id));
  }
  return Boolean(raw && teamSet.has(raw));
}

function teamEmployeesOrFormula(fieldName, ids) {
  if (ids.length === 0) return 'FALSE()';
  if (ids.length === 1) return employeeLinkMatchesFormula(fieldName, ids[0]);
  return `OR(${ids.map((id) => employeeLinkMatchesFormula(fieldName, id)).join(',')})`;
}

const TEAM_OR_EMPLOYEE_OR_MAX = 45;

/** Заказы на дату для сотрудников команды (без фильтра по полю Org — оно lookup/формула и часто не совпадает с record id организации). */
async function fetchOrdersForTeamMembers(dateISO, teamMemberIds, orderFields, atGet) {
  const dCond = dateCondOrders(dateISO);
  const notCancelled = `NOT(OR(LOWER({${F.ORDER_STATUS}})='cancelled',LOWER({${F.ORDER_STATUS}})='canceled',LOWER({${F.ORDER_STATUS}})='deleted'))`;
  const ids = [...teamMemberIds];

  if (ids.length === 0) return [];

  const collectPaged = async (filterByFormula) => {
    const all = [];
    let offset;
    do {
      const params = {
        filterByFormula,
        'fields[]': orderFields,
        pageSize: 100,
      };
      if (offset) params.offset = offset;
      const resp = await atGet(TABLE.ORDERS, params);
      all.push(...(resp.records || []));
      offset = resp.offset;
    } while (offset);
    return all;
  };

  const set = new Set(ids);
  const dateAndOpen = `AND(${dCond}, ${notCancelled})`;

  if (ids.length <= TEAM_OR_EMPLOYEE_OR_MAX) {
    const empOr = teamEmployeesOrFormula(F.ORDER_EMPLOYEE, ids);
    let found = await collectPaged(`AND(${dateAndOpen}, ${empOr})`);
    // Если формула по связи Employee в Airtable не матчится — те же заказы, фильтр по rec id в коде
    if (found.length === 0) {
      const wide = await collectPaged(dateAndOpen);
      found = wide.filter((o) => orderEmployeeInTeamSet(o, set));
    }
    return found;
  }

  const wide = await collectPaged(dateAndOpen);
  return wide.filter((o) => orderEmployeeInTeamSet(o, set));
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');
    const date = url.searchParams.get('date');

    if (!org || !date) {
      return json(res, 400, { ok: false, error: 'org and date parameters required' });
    }

    console.log('[team_stats] Fetching stats for org:', org, 'date:', date);

    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      'fields[]': [
        F.ORG_NAME,
        F.ORG_CONTRACT_TYPE,
        F.ORG_TEAM_MIN_DELIVERY,
        F.ORG_TEAM_MIN_FREE_AMB,
      ],
      maxRecords: 1
    });

    const orgRec = one(orgResp.records);
    if (!orgRec) {
      return json(res, 404, { ok: false, error: 'Organization not found' });
    }

    const contractType = orgRec.fields?.[F.ORG_CONTRACT_TYPE];
    if (contractType !== 'Ambassador') {
      return json(res, 400, { ok: false, error: 'This endpoint is only for Ambassador organizations' });
    }

    const minDelivery = orgRec.fields?.[F.ORG_TEAM_MIN_DELIVERY] || 9;
    const minFree = orgRec.fields?.[F.ORG_TEAM_MIN_FREE_AMB] || 10;

    const memberFilterFormula = `AND(
        {${F.EMP_ORG_LOOKUP}}='${String(org).replace(/'/g, "\\'")}',
        OR(
          TRIM({${F.EMP_ROLE}})='Ambassador',
          TRIM({${F.EMP_ROLE}})='TeamMember'
        ),
        OR(LOWER({${F.EMP_STATUS}})='active', {${F.EMP_STATUS}}='Active')
      )`;

    const memberRecords = [];
    let memOffset;
    do {
      const params = {
        filterByFormula: memberFilterFormula,
        'fields[]': [F.EMP_NAME, F.EMP_ROLE],
        pageSize: 100,
      };
      if (memOffset) params.offset = memOffset;
      const membersResp = await atGet(TABLE.EMPLOYEES, params);
      memberRecords.push(...(membersResp.records || []));
      memOffset = membersResp.offset;
    } while (memOffset);

    const teamMemberIds = new Set(memberRecords.map((r) => r.id));

    const orderFields = [
      F.ORDER_DATE,
      F.ORDER_STATUS,
      F.ORDER_EMPLOYEE,
      F.ORDER_PAYMENT,
      F.ORDER_ORG_ID,
    ];

    const orders = await fetchOrdersForTeamMembers(date, teamMemberIds, orderFields, atGet);

    console.log('[team_stats] Found orders:', orders.length);

    const paymentIds = [];
    for (const order of orders) {
      const pl = order.fields?.[F.ORDER_PAYMENT];
      const pid = Array.isArray(pl) ? pl[0] : pl;
      if (pid) paymentIds.push(pid);
    }

    const paymentStatusById = {};
    const uniquePay = [...new Set(paymentIds)];
    const PAY_BATCH = 40;
    if (uniquePay.length) {
      try {
        for (let i = 0; i < uniquePay.length; i += PAY_BATCH) {
          const chunk = uniquePay.slice(i, i + PAY_BATCH);
          const payFormula = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
          const payResp = await atGet(TABLE.PAYMENTS, {
            filterByFormula: payFormula,
            'fields[]': [F.PAYMENT_STATUS],
            pageSize: 100,
          });
          for (const pr of payResp.records || []) {
            paymentStatusById[pr.id] = String(pr.fields?.[F.PAYMENT_STATUS] || '').trim().toLowerCase();
          }
        }
      } catch (e) {
        console.error('[team_stats] payments fetch:', e.message);
      }
    }

    const statusIsPaid = (st) => {
      const s = String(st || '').trim().toLowerCase();
      return s === 'succeeded' || s === 'paid' || s === 'success';
    };

    const isOrderPaid = (order) => {
      const pl = order.fields?.[F.ORDER_PAYMENT];
      const pid = Array.isArray(pl) ? pl[0] : pl;
      if (!pid) return true;
      const st = paymentStatusById[pid];
      return statusIsPaid(st);
    };

    const paidOrders = orders.filter(isOrderPaid);
    const totalOrders = orders.length;
    const paidOrdersCount = paidOrders.length;
    const pendingOrdersCount = totalOrders - paidOrdersCount;

    const members = memberRecords.map((emp) => {
      const empId = emp.id;
      const order = orders.find((o) => {
        const empLink = o.fields?.[F.ORDER_EMPLOYEE];
        const empLinkId = Array.isArray(empLink) ? empLink[0] : empLink;
        return empLinkId === empId;
      });

      const isPaid = order ? paidOrders.includes(order) : false;

      return {
        id: empId,
        name: emp.fields?.[F.EMP_NAME] || 'Unknown',
        role: String(emp.fields?.[F.EMP_ROLE] || 'TeamMember').trim(),
        hasOrder: !!order,
        isPaid,
      };
    });

    console.log('[team_stats] Team members:', members.length, 'paid orders:', paidOrdersCount);

    const deliveryAllowed = paidOrdersCount >= minDelivery;
    const ambassadorFree = paidOrdersCount >= minFree;

    const stats = {
      totalOrders,
      paidOrders: paidOrdersCount,
      pendingOrders: pendingOrdersCount,
      minForDelivery: minDelivery,
      minForFreeAmbassador: minFree,
      deliveryAllowed,
      ambassadorFree,
      members,
    };

    return json(res, 200, {
      ok: true,
      date,
      stats,
    });

  } catch (err) {
    console.error('[team_stats] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Failed to fetch team stats'
    });
  }
};
