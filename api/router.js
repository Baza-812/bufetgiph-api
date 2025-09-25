// /api/router.js
// ОДНА serverless-функция, которая диспатчит на внутренние обработчики

const url = require('url');

// Импортируем обработчики из lib/handlers
const order         = require('../lib/handlers/order.js');
const orderUpdate   = require('../lib/handlers/order_update.js');
const orderCancel   = require('../lib/handlers/order_cancel.js');
const dates         = require('../lib/handlers/dates.js');
const menu          = require('../lib/handlers/menu.js');
const hrOrders      = require('../lib/handlers/hr_orders.js');
// Health можно реализовать прямо здесь, чтобы не тащить ещё один файл:
async function health(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.end(JSON.stringify({ ok:true, time:new Date().toISOString() }));
}

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

    // Таблица маршрутов: сохраняем старые пути 1:1
    const routes = {
      'health'        : health,
      'order'         : order,
      'order_update'  : orderUpdate,
      'order_cancel'  : orderCancel,
      'dates'         : dates,
      'menu'          : menu,
      'order_manager' : orderManager,
      'hr_orders'     : hrOrders
    };

    const fn = routes[path];
    if (!fn) {
      return sendJson(res, 404, { error: 'Not found', path });
    }

    // Передаём управление исходному обработчику (их код не меняем)
    return fn(req, res);
  } catch (e) {
    return sendJson(res, 500, { error: e.message || String(e) });
  }
};

// (Опционально) Явно фиксируем рантайм:
module.exports.config = { runtime: 'nodejs18.x' };
