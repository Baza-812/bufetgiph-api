// /api/router.js — единая serverless-функция с ленивыми require и безопасной ошибкой

const url = require('url');

const DEBUG_STACK = (process.env.DEBUG_ROUTES || 'off').toLowerCase() === 'on';

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.setHeader('Access-Control-Allow-Origin','*');
      res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
      return res.end();
    }

    const parsed = url.parse(req.url);
    const path = (parsed.pathname || '').replace(/^\/api\/?/, '').toLowerCase();

    // Карта "путь -> лоадер", чтобы не падать, если какого-то файла нет
    const loaders = {
      'health'          : () => require('../lib/handlers/health.js'),
      'order'           : () => require('../lib/handlers/order.js'),
      'order_update'    : () => require('../lib/handlers/order_update.js'),
      'order_cancel'    : () => require('../lib/handlers/order_cancel.js'),
      'dates'           : () => require('../lib/handlers/dates.js'),
      'menu'            : () => require('../lib/handlers/menu.js'),
      'hr_orders'       : () => require('../lib/handlers/hr_orders.js'),
      'register'        : () => require('../lib/handlers/register.js'),
      'hr_employees'    : () => require('../lib/handlers/hr_employees.js'),
      'org_info'        : () => require('../lib/handlers/org_info.js'),
      'busy'            : () => require('../lib/handlers/busy.js'),
      'order_summary'   : () => require('../lib/handlers/order_summary.js'),
      'order_manager'   : () => require('../lib/handlers/order_manager.js'),
      'org_meta'        : () => require('../lib/handlers/org_meta.js'),
      'employee_meta'   : () => require('../lib/handlers/employee_meta.js'),
      'payment_create'  : () => require('../lib/handlers/payment_create.js'),
      'payment_webhook' : () => require('../lib/handlers/payment_webhook.js'),
      'payment_status'  : () => require('../lib/handlers/payment_status.js'),
      'payment_refund'  : () => require('../lib/handlers/payment_refund.js'),
      'pay_all'         : () => require('../lib/handlers/pay_all.js'), // ✅ ДОБАВЛЕНО
    };

    const load = loaders[path];
    if (!load) return sendJson(res, 404, { error: 'not_found', path });

    let fn;
    try {
      fn = load(); // ленивый require целевого хэндлера
    } catch (e) {
      return sendJson(res, 500, {
        error: 'handler_load_failed',
        path,
        message: e.message || String(e),
        ...(DEBUG_STACK ? { stack: String(e.stack || '') } : {})
      });
    }

    try {
      return await fn(req, res);
    } catch (e) {
      return sendJson(res, 500, {
        error: 'handler_runtime_error',
        path,
        message: e.message || String(e),
        ...(DEBUG_STACK ? { stack: String(e.stack || '') } : {})
      });
    }
  } catch (e) {
    return sendJson(res, 500, { error: e.message || String(e) });
  }
};

// Явный рантайм, чтобы работал global fetch и пр.
module.exports.config = { runtime: 'nodejs18.x' };
