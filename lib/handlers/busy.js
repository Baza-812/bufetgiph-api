// /api/busy.js — надежный фолбэк через /api/hr_orders
const { json, withRateLimit } = require('../lib/utils');

function getOrigin(req) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host']  || req.headers.host || '';
    return `${proto}://${host}`;
  } catch { return ''; }
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  const { employeeID, org, token, dates = '', debug: wantDebug } = req.query || {};
  if (!employeeID || !org || !token) {
    return json(res, 400, { error: 'employeeID, org, token are required' });
  }

  const origin = getOrigin(req);
  const list = String(dates || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const busy  = {};
  const debug = [];

  for (const d of list) {
    // строим URL на уже рабочий маршрут
    const u = new URL('/api/hr_orders', origin || 'http://localhost:3000');
    u.searchParams.set('mode', 'single');
    u.searchParams.set('employeeID', employeeID);
    u.searchParams.set('org', org);
    u.searchParams.set('token', token);
    u.searchParams.set('date', d);

    try {
      const r = await fetch(u.toString(), { method: 'GET' });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`${r.status} ${r.statusText}${txt ? `: ${txt}` : ''}`);
      }
      const js = await r.json();
      const has = Boolean(js && js.summary && js.summary.orderId);
      busy[d] = has;

      if (wantDebug) {
        debug.push({ date: d, url: u.toString(), ok: true, found: has ? js.summary.orderId : null });
      }
    } catch (e) {
      // НЕ роняем 500, просто считаем «свободно» и отдаём диагностику
      busy[d] = false;
      if (wantDebug) {
        debug.push({ date: d, url: u.toString(), ok: false, error: e?.message || String(e) });
      }
    }
  }

  return json(res, 200, { ok: true, busy, ...(wantDebug ? { debug } : {}) });
});
