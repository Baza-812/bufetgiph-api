// /lib/handlers/dates.js
// Возвращает массив опубликованных дат меню.
// Ответ: { ok: true, dates: ["YYYY-MM-DD", ...] }

const { json, withRateLimit, atGet, TABLE } = require('../../lib/utils');

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    // Если нужно будет фильтровать по org — добавим, сейчас берём все опубликованные даты.
    const filter = `AND({Published}=1)`;

    const resp = await atGet(TABLE.MENU, {
      filterByFormula: filter,
      "fields[]": ["Date", "Published"],
      pageSize: 100
    });

    const dates = (resp.records || [])
      .map(r => (r.fields?.["Date"] || '').toString().slice(0, 10)) // "YYYY-MM-DD"
      .filter(Boolean);

    // уникализируем и сортируем
    const uniq = Array.from(new Set(dates)).sort((a, b) => a.localeCompare(b));

    return json(res, 200, { ok: true, dates: uniq });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || String(e) });
  }
}, { windowMs: 4000, max: 30 });
