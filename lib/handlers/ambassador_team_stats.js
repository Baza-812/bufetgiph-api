// lib/handlers/ambassador_team_stats.js
// GET /api/ambassador/team_stats?org=orgXXX&date=2026-03-20

const { json, atGet, one, TABLE, F } = require('../utils');

const ORDER_DATE_ISO = process.env.FLD_ORDER_DATE_ISO || 'OrderDateISO';

function dateCondOrders(dateISO) {
  return `OR({${ORDER_DATE_ISO}}='${dateISO}', DATETIME_FORMAT({${F.ORDER_DATE}}, 'YYYY-MM-DD')='${dateISO}')`;
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

    const orgRecId = orgRec.id;
    const minDelivery = orgRec.fields?.[F.ORG_TEAM_MIN_DELIVERY] || 9;
    const minFree = orgRec.fields?.[F.ORG_TEAM_MIN_FREE_AMB] || 10;

    const dCond = dateCondOrders(date);
    const notCancelled = `NOT(OR(LOWER({${F.ORDER_STATUS}})='cancelled',LOWER({${F.ORDER_STATUS}})='canceled',LOWER({${F.ORDER_STATUS}})='deleted'))`;
    const orgCond = `OR(
      {${F.ORDER_ORG_ID}}='${orgRecId}',
      FIND('${orgRecId}', ARRAYJOIN({${F.ORDER_ORG_ID}})) > 0
    )`;

    const membersResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `AND(
        {${F.EMP_ORG_LOOKUP}}='${org}',
        OR(
          TRIM({${F.EMP_ROLE}})='Ambassador',
          TRIM({${F.EMP_ROLE}})='TeamMember'
        ),
        OR(LOWER({${F.EMP_STATUS}})='active', {${F.EMP_STATUS}}='Active')
      )`,
      'fields[]': [F.EMP_NAME, F.EMP_ROLE],
      pageSize: 100,
    });

    const teamMemberIds = new Set((membersResp.records || []).map((r) => r.id));

    const orderFields = [
      F.ORDER_STATUS,
      F.ORDER_EMPLOYEE,
      F.ORDER_PAYMENT,
      F.ORDER_ORG_ID,
    ];

    let ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `AND(${dCond}, ${notCancelled}, ${orgCond})`,
      'fields[]': orderFields,
      pageSize: 100,
    });

    let orders = ordersResp.records || [];

    // Заказы без заполненного Org (старые записи): те же сотрудники команды на эту дату
    if (orders.length === 0 && teamMemberIds.size > 0) {
      const wideResp = await atGet(TABLE.ORDERS, {
        filterByFormula: `AND(${dCond}, ${notCancelled})`,
        'fields[]': orderFields,
        pageSize: 100,
      });
      orders = (wideResp.records || []).filter((o) => {
        const empLink = o.fields?.[F.ORDER_EMPLOYEE];
        const eid = Array.isArray(empLink) ? empLink[0] : empLink;
        if (!eid || !teamMemberIds.has(eid)) return false;
        const orgLink = o.fields?.[F.ORDER_ORG_ID];
        const hasOrg = Array.isArray(orgLink) ? orgLink.length > 0 : !!orgLink;
        return !hasOrg;
      });
    }

    console.log('[team_stats] Found orders:', orders.length);

    const paymentIds = [];
    for (const order of orders) {
      const pl = order.fields?.[F.ORDER_PAYMENT];
      const pid = Array.isArray(pl) ? pl[0] : pl;
      if (pid) paymentIds.push(pid);
    }

    const paymentStatusById = {};
    const uniquePay = [...new Set(paymentIds)];
    if (uniquePay.length) {
      const payFormula = `OR(${uniquePay.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
      try {
        const payResp = await atGet(TABLE.PAYMENTS, {
          filterByFormula: payFormula,
          'fields[]': [F.PAYMENT_STATUS],
          pageSize: 100,
        });
        for (const pr of payResp.records || []) {
          paymentStatusById[pr.id] = String(pr.fields?.[F.PAYMENT_STATUS] || '').toLowerCase();
        }
      } catch (e) {
        console.error('[team_stats] payments fetch:', e.message);
      }
    }

    const isOrderPaid = (order) => {
      const pl = order.fields?.[F.ORDER_PAYMENT];
      const pid = Array.isArray(pl) ? pl[0] : pl;
      if (!pid) return true;
      const st = paymentStatusById[pid];
      return st === 'succeeded';
    };

    const paidOrders = orders.filter(isOrderPaid);
    const totalOrders = orders.length;
    const paidOrdersCount = paidOrders.length;
    const pendingOrdersCount = totalOrders - paidOrdersCount;

    const members = (membersResp.records || []).map((emp) => {
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
      members,
    });

  } catch (err) {
    console.error('[team_stats] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Failed to fetch team stats'
    });
  }
};
