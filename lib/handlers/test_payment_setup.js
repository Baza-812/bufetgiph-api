// lib/handlers/test_payment_setup.js
// Тестовый endpoint для проверки настройки Payment

const { json, atGet, TABLE, F } = require('../utils');

module.exports = async (req, res) => {
  try {
    const results = {
      ok: true,
      checks: {}
    };

    // 1. Проверяем наличие таблицы Banks
    try {
      const banksResp = await atGet(TABLE.BANKS, {
        maxRecords: 1,
        'fields[]': ['Name']
      });
      results.checks.banks_table = { 
        ok: true, 
        count: banksResp.records?.length || 0 
      };
    } catch (e) {
      results.checks.banks_table = { 
        ok: false, 
        error: e.message 
      };
    }

    // 2. Проверяем наличие таблицы Payments
    try {
      const paymentsResp = await atGet(TABLE.PAYMENTS, {
        maxRecords: 1,
        'fields[]': ['Status']
      });
      results.checks.payments_table = { 
        ok: true, 
        count: paymentsResp.records?.length || 0 
      };
    } catch (e) {
      results.checks.payments_table = { 
        ok: false, 
        error: e.message 
      };
    }

    // 3. Проверяем константы
    results.checks.constants = {
      TABLE_BANKS: TABLE.BANKS,
      TABLE_PAYMENTS: TABLE.PAYMENTS,
      F_BANK_MERCHANT_ID: F.BANK_MERCHANT_ID,
      F_PAYMENT_STATUS: F.PAYMENT_STATUS,
      F_ORDER_PAYMENT: F.ORDER_PAYMENT,
    };

    // 4. Проверяем environment variables
    results.checks.env = {
      has_airtable_base: !!process.env.AIRTABLE_BASE_ID,
      has_airtable_key: !!process.env.AIRTABLE_API_KEY,
      has_payment_return_url: !!process.env.PAYMENT_RETURN_URL,
    };

    return json(res, 200, results);

  } catch (err) {
    console.error('test_payment_setup error:', err);
    return json(res, 500, { 
      ok: false,
      error: err.message,
      stack: err.stack 
    });
  }
};
