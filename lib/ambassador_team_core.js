// Общая логика подсчёта оплаченных заказов команды Ambassador на дату доставки (как ambassador_team_stats).
const { atGet, one, TABLE, F } = require('./utils');

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

async function fetchOrdersForTeamMembers(dateISO, teamMemberIds, orderFields, atGetFn) {
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
      const resp = await atGetFn(TABLE.ORDERS, params);
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
    if (found.length === 0) {
      const wide = await collectPaged(dateAndOpen);
      found = wide.filter((o) => orderEmployeeInTeamSet(o, set));
    }
    return found;
  }

  const wide = await collectPaged(dateAndOpen);
  return wide.filter((o) => orderEmployeeInTeamSet(o, set));
}

/**
 * @returns {Promise<{
 *   orgRec: object|null,
 *   minDelivery: number,
 *   minFree: number,
 *   orders: object[],
 *   paidOrders: object[],
 *   paidCount: number,
 *   totalCount: number,
 *   deliveryAllowed: boolean,
 *   ambassadorFree: boolean,
 *   memberRecords: object[],
 * }>}
 */
async function computeAmbassadorTeamPaidStats(orgCode, deliveryDateISO, atGetFn = atGet) {
  const orgResp = await atGetFn(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${String(orgCode).replace(/'/g, "\\'")}'`,
    'fields[]': [
      F.ORG_NAME,
      F.ORG_CONTRACT_TYPE,
      F.ORG_TEAM_MIN_DELIVERY,
      F.ORG_TEAM_MIN_FREE_AMB,
      F.ORG_CUTOFF,
      F.ORG_TZ,
      F.ORG_DOMAIN,
      F.ORG_AMB_NOTIFY_EMAIL,
      F.ORG_AMB_TELEGRAM_CHAT_ID,
    ],
    maxRecords: 1,
  });

  const orgRec = one(orgResp.records);
  if (!orgRec) {
    return {
      orgRec: null,
      minDelivery: 9,
      minFree: 10,
      orders: [],
      paidOrders: [],
      paidCount: 0,
      totalCount: 0,
      deliveryAllowed: false,
      ambassadorFree: false,
      memberRecords: [],
    };
  }

  const minDelivery = orgRec.fields?.[F.ORG_TEAM_MIN_DELIVERY] || 9;
  const minFree = orgRec.fields?.[F.ORG_TEAM_MIN_FREE_AMB] || 10;

  const memberFilterFormula = `AND(
      {${F.EMP_ORG_LOOKUP}}='${String(orgCode).replace(/'/g, "\\'")}',
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
      'fields[]': [F.EMP_NAME, F.EMP_ROLE, F.EMP_EMAIL, F.EMP_TOKEN],
      pageSize: 100,
    };
    if (memOffset) params.offset = memOffset;
    const membersResp = await atGetFn(TABLE.EMPLOYEES, params);
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

  const orders = await fetchOrdersForTeamMembers(deliveryDateISO, teamMemberIds, orderFields, atGetFn);

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
        const payResp = await atGetFn(TABLE.PAYMENTS, {
          filterByFormula: payFormula,
          'fields[]': [F.PAYMENT_STATUS],
          pageSize: 100,
        });
        for (const pr of payResp.records || []) {
          paymentStatusById[pr.id] = String(pr.fields?.[F.PAYMENT_STATUS] || '').trim().toLowerCase();
        }
      }
    } catch (e) {
      console.error('[ambassador_team_core] payments fetch:', e.message);
    }
  }

  const statusIsPaid = (st) => {
    const s = String(st || '').trim().toLowerCase();
    return s === 'succeeded' || s === 'paid' || s === 'success';
  };

  const isOrderPaid = (order) => {
    const ordSt = String(order.fields?.[F.ORDER_STATUS] || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
    if (ordSt === 'awaitingpayment') return false;
    const pl = order.fields?.[F.ORDER_PAYMENT];
    const pid = Array.isArray(pl) ? pl[0] : pl;
    if (!pid) return true;
    const st = paymentStatusById[pid];
    return statusIsPaid(st);
  };

  const paidOrders = orders.filter(isOrderPaid);
  const paidCount = paidOrders.length;
  const totalCount = orders.length;

  return {
    orgRec,
    minDelivery,
    minFree,
    orders,
    paidOrders,
    paidCount,
    totalCount,
    deliveryAllowed: paidCount >= minDelivery,
    ambassadorFree: paidCount >= minFree,
    memberRecords,
  };
}

module.exports = {
  computeAmbassadorTeamPaidStats,
  fetchOrdersForTeamMembers,
  dateCondOrders,
};
