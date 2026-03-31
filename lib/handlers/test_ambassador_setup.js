// lib/handlers/test_ambassador_setup.js
// GET /api/test_ambassador_setup
// Проверка настройки Ambassador программы

const { json, atGet, TABLE, F } = require('../utils');

module.exports = async (req, res) => {
  try {
    const checks = {
      tables: {},
      constants: {},
      testData: {},
    };

    // Проверяем таблицы
    try {
      const pricingPlansResp = await atGet(TABLE.PRICING_PLANS, { maxRecords: 1 });
      checks.tables.pricing_plans = {
        ok: true,
        count: pricingPlansResp.records?.length || 0,
      };
    } catch (e) {
      checks.tables.pricing_plans = { ok: false, error: e.message };
    }

    try {
      const ambassadorAppsResp = await atGet(TABLE.AMBASSADOR_APPS, { maxRecords: 1 });
      checks.tables.ambassador_apps = {
        ok: true,
        count: ambassadorAppsResp.records?.length || 0,
      };
    } catch (e) {
      checks.tables.ambassador_apps = { ok: false, error: e.message };
    }

    // Проверяем константы
    checks.constants = {
      TABLE_PRICING_PLANS: TABLE.PRICING_PLANS,
      TABLE_AMBASSADOR_APPS: TABLE.AMBASSADOR_APPS,
      F_ORG_CONTRACT_TYPE: F.ORG_CONTRACT_TYPE,
      F_ORG_TEAM_MIN_DELIVERY: F.ORG_TEAM_MIN_DELIVERY,
      F_ORG_TEAM_MIN_FREE_AMB: F.ORG_TEAM_MIN_FREE_AMB,
      F_ORG_PRICING_PLAN: F.ORG_PRICING_PLAN,
      F_PLAN_FULL_PRICE: F.PLAN_FULL_PRICE,
      F_PLAN_LIGHT_PRICE: F.PLAN_LIGHT_PRICE,
    };

    // Проверяем есть ли Ambassador организации
    try {
      const ambassadorOrgsResp = await atGet(TABLE.ORGS, {
        filterByFormula: `{${F.ORG_CONTRACT_TYPE}}='Ambassador'`,
        'fields[]': [F.ORG_ID, F.ORG_NAME],
        maxRecords: 5,
      });
      checks.testData.ambassador_orgs = {
        ok: true,
        count: ambassadorOrgsResp.records?.length || 0,
        examples: (ambassadorOrgsResp.records || []).map(r => ({
          id: r.id,
          orgId: r.fields?.[F.ORG_ID],
          name: r.fields?.[F.ORG_NAME],
        })),
      };
    } catch (e) {
      checks.testData.ambassador_orgs = { ok: false, error: e.message };
    }

    // Проверяем есть ли Ambassador сотрудники
    try {
      const ambassadorEmpsResp = await atGet(TABLE.EMPLOYEES, {
        filterByFormula: `{${F.EMP_ROLE}}='Ambassador'`,
        'fields[]': [F.EMP_NAME, F.EMP_ROLE],
        maxRecords: 5,
      });
      checks.testData.ambassador_employees = {
        ok: true,
        count: ambassadorEmpsResp.records?.length || 0,
      };
    } catch (e) {
      checks.testData.ambassador_employees = { ok: false, error: e.message };
    }

    // Проверяем есть ли TeamMember сотрудники
    try {
      const teamMembersResp = await atGet(TABLE.EMPLOYEES, {
        filterByFormula: `{${F.EMP_ROLE}}='TeamMember'`,
        'fields[]': [F.EMP_NAME, F.EMP_ROLE],
        maxRecords: 5,
      });
      checks.testData.team_members = {
        ok: true,
        count: teamMembersResp.records?.length || 0,
      };
    } catch (e) {
      checks.testData.team_members = { ok: false, error: e.message };
    }

    return json(res, 200, {
      ok: true,
      checks,
    });

  } catch (err) {
    console.error('[test_ambassador_setup] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Setup test failed'
    });
  }
};
