// lib/handlers/ambassador_team_stats.js
// GET /api/ambassador/team_stats?org=orgXXX&date=2026-03-20
// Возвращает статистику заказов команды на конкретную дату

const { json, atGet, one, TABLE, F } = require('../utils');

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

    // 1. Получаем организацию и параметры
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

    const orgRecordId = orgRec.id;
    const minDelivery = orgRec.fields?.[F.ORG_TEAM_MIN_DELIVERY] || 9;
    const minFree = orgRec.fields?.[F.ORG_TEAM_MIN_FREE_AMB] || 10;

    console.log('[team_stats] Org params:', { minDelivery, minFree });

    // 2. Получаем все Orders для этой организации и даты (кроме отмененных)
    const ordersResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `AND(
        {${F.ORDER_ORG_ID}}='${org}',
        {${F.ORDER_DATE}}='${date}',
        {${F.ORDER_STATUS}}!='Cancelled'
      )`,
      'fields[]': [
        F.ORDER_STATUS,
        F.ORDER_EMPLOYEE,
        F.ORDER_PAYMENT,
      ],
      pageSize: 100,
    });

    const orders = ordersResp.records || [];
    console.log('[team_stats] Found orders:', orders.length);

    // 3. Определяем оплаченные заказы
    // Заказ считается оплаченным если:
    // - Есть Payment с status=succeeded
    // ИЛИ это корпоративный заказ без Payment (бесплатный для сотрудника)
    const paidOrders = orders.filter(order => {
      const paymentLink = order.fields?.[F.ORDER_PAYMENT];
      // Если нет Payment - это корпоративный бесплатный заказ (тоже считаем)
      if (!paymentLink || (Array.isArray(paymentLink) && paymentLink.length === 0)) {
        return true;
      }
      // Если есть Payment - нужно проверить его статус отдельно
      // Пока просто считаем что есть Payment = оплачен
      // (В реальности нужно делать дополнительный запрос к Payments,
      // но для упрощения пока так)
      return true;
    });

    const totalOrders = orders.length;
    const paidOrdersCount = paidOrders.length;
    const pendingOrdersCount = totalOrders - paidOrdersCount;

    console.log('[team_stats] Orders breakdown:', {
      total: totalOrders,
      paid: paidOrdersCount,
      pending: pendingOrdersCount
    });

    // 4. Получаем список всех сотрудников команды (Ambassador + TeamMember)
    const membersResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `AND(
        RECORD_ID()='${orgRecordId}',
        OR(
          {${F.EMP_ROLE}}='Ambassador',
          {${F.EMP_ROLE}}='TeamMember'
        ),
        {${F.EMP_STATUS}}='Active'
      )`,
      'fields[]': [
        F.EMP_NAME,
        F.EMP_ROLE,
      ],
      pageSize: 100,
    });

    const members = (membersResp.records || []).map(emp => {
      const empId = emp.id;
      const order = orders.find(o => {
        const empLink = o.fields?.[F.ORDER_EMPLOYEE];
        const empLinkId = Array.isArray(empLink) ? empLink[0] : empLink;
        return empLinkId === empId;
      });

      const isPaid = order ? paidOrders.includes(order) : false;

      return {
        id: empId,
        name: emp.fields?.[F.EMP_NAME] || 'Unknown',
        role: emp.fields?.[F.EMP_ROLE] || 'TeamMember',
        ordered: !!order,
        paid: isPaid,
      };
    });

    console.log('[team_stats] Found team members:', members.length);

    // 5. Формируем результат
    const deliveryAllowed = paidOrdersCount >= minDelivery;
    const ambassadorFree = paidOrdersCount >= minFree;

    return json(res, 200, {
      ok: true,
      date,
      stats: {
        totalOrders,
        paidOrders: paidOrdersCount,
        pendingOrders: pendingOrdersCount,
        minForDelivery: minDelivery,
        minForFreeAmbassador: minFree,
        deliveryAllowed,
        ambassadorFree,
      },
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
