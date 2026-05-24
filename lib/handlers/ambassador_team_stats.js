// lib/handlers/ambassador_team_stats.js
// GET /api/ambassador/team_stats?org=orgXXX&date=2026-03-20

const { json, F } = require('../utils');
const { formatOrgCutoffTimeLabel } = require('../org_cutoff_format');
const { computeAmbassadorTeamPaidStats } = require('../ambassador_team_core');

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

    const statsBundle = await computeAmbassadorTeamPaidStats(org, date);
    if (!statsBundle.orgRec) {
      return json(res, 404, { ok: false, error: 'Organization not found' });
    }

    const contractType = statsBundle.orgRec.fields?.[F.ORG_CONTRACT_TYPE];
    if (contractType !== 'Ambassador') {
      return json(res, 400, { ok: false, error: 'This endpoint is only for Ambassador organizations' });
    }

    const orgRecFull = statsBundle.orgRec;
    const minDelivery = statsBundle.minDelivery;
    const minFree = statsBundle.minFree;
    const paidOrdersCount = statsBundle.paidCount;
    const totalOrders = statsBundle.totalCount;
    const pendingOrdersCount = totalOrders - paidOrdersCount;

    const members = statsBundle.memberRecords.map((emp) => {
      const empId = emp.id;
      const order = statsBundle.orders.find((o) => {
        const empLink = o.fields?.[F.ORDER_EMPLOYEE];
        const empLinkId = Array.isArray(empLink) ? empLink[0] : empLink;
        return empLinkId === empId;
      });

      const isPaid = order ? statsBundle.paidOrders.includes(order) : false;

      return {
        id: empId,
        name: emp.fields?.[F.EMP_NAME] || 'Unknown',
        role: String(emp.fields?.[F.EMP_ROLE] || 'TeamMember').trim(),
        hasOrder: !!order,
        isPaid,
      };
    });

    const stats = {
      totalOrders,
      paidOrders: paidOrdersCount,
      pendingOrders: pendingOrdersCount,
      minForDelivery: minDelivery,
      minForFreeAmbassador: minFree,
      deliveryAllowed: statsBundle.deliveryAllowed,
      ambassadorFree: statsBundle.ambassadorFree,
      members,
    };

    const cutoffTimeLabel = formatOrgCutoffTimeLabel(orgRecFull.fields?.[F.ORG_CUTOFF]) || '';

    return json(res, 200, {
      ok: true,
      date,
      cutoffTimeLabel,
      stats,
    });
  } catch (err) {
    console.error('[team_stats] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Failed to fetch team stats',
    });
  }
};
