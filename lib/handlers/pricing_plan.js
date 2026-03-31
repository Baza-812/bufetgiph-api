// lib/handlers/pricing_plan.js
// GET /api/pricing_plan?org=orgXXX
// Возвращает тарифный план и параметры для организации

const { json, atGet, one, TABLE, F } = require('../utils');

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');

    if (!org) {
      return json(res, 400, { ok: false, error: 'org parameter required' });
    }

    console.log('[pricing_plan] Fetching pricing for org:', org);

    // Получаем Organizations
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${org}'`,
      'fields[]': [
        F.ORG_NAME,
        F.ORG_CONTRACT_TYPE,
        F.ORG_TEAM_MIN_DELIVERY,
        F.ORG_TEAM_MIN_FREE_AMB,
        F.ORG_PRICING_PLAN,
        F.ORG_DELIVERY_ADDRESS,
        F.ORG_BANK,
      ],
      maxRecords: 1
    });

    const orgRec = one(orgResp.records);
    if (!orgRec) {
      console.log('[pricing_plan] Organization not found:', org);
      return json(res, 404, { ok: false, error: 'Organization not found' });
    }

    const contractType = orgRec.fields?.[F.ORG_CONTRACT_TYPE];
    console.log('[pricing_plan] Contract type:', contractType);

    // Для Corporate - возвращаем только тип (цены не нужны)
    if (contractType === 'Corporate') {
      return json(res, 200, {
        ok: true,
        contractType: 'Corporate',
        orgName: orgRec.fields?.[F.ORG_NAME] || '',
      });
    }

    // Для Ambassador - получаем PricingPlan
    const planLink = orgRec.fields?.[F.ORG_PRICING_PLAN];
    const planId = Array.isArray(planLink) ? planLink[0] : planLink;

    if (!planId) {
      console.log('[pricing_plan] No pricing plan configured for org:', org);
      return json(res, 400, { ok: false, error: 'No pricing plan configured for this organization' });
    }

    console.log('[pricing_plan] Fetching pricing plan:', planId);

    // Получаем PricingPlan
    const planResp = await atGet(TABLE.PRICING_PLANS, {
      filterByFormula: `RECORD_ID()='${planId}'`,
      'fields[]': [
        F.PLAN_NAME,
        F.PLAN_FULL_PRICE,
        F.PLAN_LIGHT_PRICE,
        F.PLAN_IS_ACTIVE,
      ],
      maxRecords: 1
    });

    const plan = one(planResp.records);
    if (!plan) {
      console.log('[pricing_plan] Pricing plan not found:', planId);
      return json(res, 404, { ok: false, error: 'Pricing plan not found' });
    }

    if (!plan.fields?.[F.PLAN_IS_ACTIVE]) {
      console.log('[pricing_plan] Pricing plan is inactive:', planId);
      return json(res, 400, { ok: false, error: 'Pricing plan is not active' });
    }

    // Получаем Bank info для контактов
    const bankLink = orgRec.fields?.[F.ORG_BANK];
    const bankId = Array.isArray(bankLink) ? bankLink[0] : bankLink;
    
    let bankInfo = null;
    if (bankId) {
      const bankResp = await atGet(TABLE.BANKS, {
        filterByFormula: `RECORD_ID()='${bankId}'`,
        'fields[]': [
          F.BANK_LEGAL_NAME,
          F.BANK_INN,
          F.BANK_KPP,
          F.BANK_CONTACT,
          F.BANK_FOOTER,
        ],
        maxRecords: 1
      });

      const bank = one(bankResp.records);
      if (bank) {
        bankInfo = {
          legalName: bank.fields?.[F.BANK_LEGAL_NAME] || '',
          inn: bank.fields?.[F.BANK_INN] || '',
          kpp: bank.fields?.[F.BANK_KPP] || '',
          phone: bank.fields?.[F.BANK_CONTACT] || '',
          footer: bank.fields?.[F.BANK_FOOTER] || '',
        };
      }
    }

    console.log('[pricing_plan] Returning Ambassador pricing:', {
      fullPrice: plan.fields?.[F.PLAN_FULL_PRICE],
      lightPrice: plan.fields?.[F.PLAN_LIGHT_PRICE],
    });

    return json(res, 200, {
      ok: true,
      contractType: 'Ambassador',
      orgName: orgRec.fields?.[F.ORG_NAME] || '',
      planName: plan.fields?.[F.PLAN_NAME] || '',
      fullMealPrice: plan.fields?.[F.PLAN_FULL_PRICE] || 0,
      lightMealPrice: plan.fields?.[F.PLAN_LIGHT_PRICE] || 0,
      teamMinForDelivery: orgRec.fields?.[F.ORG_TEAM_MIN_DELIVERY] || 9,
      teamMinForFreeAmbassador: orgRec.fields?.[F.ORG_TEAM_MIN_FREE_AMB] || 10,
      deliveryAddress: orgRec.fields?.[F.ORG_DELIVERY_ADDRESS] || '',
      bankInfo,
    });

  } catch (err) {
    console.error('[pricing_plan] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Failed to fetch pricing plan'
    });
  }
};
