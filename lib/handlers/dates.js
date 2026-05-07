// /lib/handlers/dates.js
// Даты для выбора:
// - Всегда будущие опубликованные даты из Menu
// - Плюс «сегодня», если текущее время <= Cutoff Time (для as=hr — HR Cutoff Time)
//
// GET /api/dates?org=org120[&as=hr]
// => { ok:true, dates:["YYYY-MM-DD", ...] }

const { json, withRateLimit } = require('../utils');
const { getOpenOrderDates } = require('../open_order_dates');
const isPreview = (process.env.VERCEL_ENV || process.env.NODE_ENV) === 'preview';

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');
    const as = (url.searchParams.get('as') || '').toLowerCase();
    const hrMode = as === 'hr';

    if (!org) return json(res, 400, { ok: false, error: 'org required' });

    const r = await getOpenOrderDates(org, hrMode);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error || 'organization not found' });

    return json(res, 200, { ok: true, dates: r.dates });
  } catch (e) {
    const msg = e?.message || String(e);
    return json(res, isPreview ? 500 : 200, { ok: !isPreview, error: msg, dates: isPreview ? undefined : [] });
  }
}, { windowMs: 4000, max: 30 });
