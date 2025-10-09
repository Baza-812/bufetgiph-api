// /lib/handlers/dates.js
// GET /api/dates?org=ORG_CODE[&as=hr]
// as=hr → использовать HR Cutoff Time (если пусто — fallback на обычный Cutoff Time)
// Ответ: { ok: true, dates: ["YYYY-MM-DD", ...] }

const { json, withRateLimit, atGet, TABLE } = require('../../lib/utils');

// Названия полей в Organizations
const F_ORG_ID        = 'OrgID';
const F_ORG_TZ        = 'Time Zone';
const F_ORG_CUTOFF    = 'Cutoff Time';
const F_ORG_HR_CUTOFF = 'HR Cutoff Time';

const DEFAULT_TZ     = process.env.DEFAULT_TZ || 'Europe/Moscow';
const DEFAULT_CUTOFF = process.env.DEFAULT_CUTOFF || '10:00';

// ---------- helpers ----------
function getTzOffsetMinutes(tz, date){
  const f = new Intl.DateTimeFormat('en-US',{
    timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const p = Object.fromEntries(f.formatToParts(date).map(o=>[o.type,o.value]));
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime())/60000;
}
function localToUtc(tz, y,m,d,hh,mm){
  const guessUTC = Date.UTC(y,m-1,d,hh,mm,0);
  const off = getTzOffsetMinutes(tz, new Date(guessUTC));
  return new Date(guessUTC - off*60000);
}
function parseHHMM(v){
  if (!v) return null;
  if (typeof v==='string'){
    const m = v.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return {hh:+m[1], mm:+m[2]};
  }
  const dt = new Date(v); if (isNaN(dt)) return null;
  return { hh: dt.getUTCHours(), mm: dt.getUTCMinutes() };
}
function isoDateUTC(d){ return d.toISOString().slice(0,10); }

/**
 * nowUtc — текущий момент в UTC
 * deliveryIso — дата поставки (YYYY-MM-DD)
 * orgRec — запись Organizations
 * useHrCutoff — флаг HR-режима
 * Возвращает true, если окно заказа ещё открыто для этой даты.
 */
function canOrderForDate(nowUtc, deliveryIso, orgRec, useHrCutoff){
  const tz = (orgRec?.fields?.[F_ORG_TZ]) || DEFAULT_TZ;

  // Выбор строки cutoff: HR → HR Cutoff Time, иначе обычный
  let cutoffStr = useHrCutoff
    ? (orgRec?.fields?.[F_ORG_HR_CUTOFF] || orgRec?.fields?.[F_ORG_CUTOFF])
    :  orgRec?.fields?.[F_ORG_CUTOFF];

  if (!cutoffStr) cutoffStr = DEFAULT_CUTOFF;

  const ct = parseHHMM(cutoffStr);
  if (!ct) {
    // если распарсить не удалось — не режем по cutoff, оставляем дату
    // но исключим прошедшие даты
    const todayIso = isoDateUTC(new Date());
    return deliveryIso >= todayIso;
  }

  const [Y,M,D] = deliveryIso.split('-').map(Number);

  // Окно закрывается ВЧЕРА (локальная TZ) в cutoff-время
  const prev = new Date(Date.UTC(Y, M-1, D));
  prev.setUTCDate(prev.getUTCDate()-1);

  const cutoffUtc = localToUtc(
    tz,
    prev.getUTCFullYear(),
    prev.getUTCMonth()+1,
    prev.getUTCDate(),
    ct.hh,
    ct.mm
  );

  return nowUtc <= cutoffUtc;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { ok:false, error:'GET only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');
    const as  = (url.searchParams.get('as') || '').toLowerCase(); // 'hr' => HR-режим
    if (!org) return json(res, 400, { ok:false, error:'org required' });

    // 1) Организация (TZ + cutoffs)
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F_ORG_ID}}='${org}'`,
      maxRecords: 1,
      "fields[]": [F_ORG_ID, F_ORG_TZ, F_ORG_CUTOFF, F_ORG_HR_CUTOFF]
    });
    const orgRec = (orgResp.records || [])[0];
    if (!orgRec) return json(res, 200, { ok:true, dates: [] });

    const useHrCutoff = (as === 'hr');

    // 2) Публикации из Menu
    const resp = await atGet(TABLE.MENU, {
      filterByFormula: `AND({Published}=1)`,
      "fields[]": ["Date", "Published"],
      pageSize: 200
    });
    const allDates = (resp.records || [])
      .map(r => (r.fields?.["Date"] || '').toString().slice(0,10))
      .filter(Boolean);

    const unique = Array.from(new Set(allDates)).sort((a,b)=>a.localeCompare(b));
    if (unique.length === 0) return json(res, 200, { ok:true, dates: [] });

    const nowUtc = new Date();
    const dates = unique.filter(d => canOrderForDate(nowUtc, d, orgRec, useHrCutoff));

    return json(res, 200, { ok:true, dates });
  } catch (e) {
    console.error('DATES_ERROR', e?.message || e);
    return json(res, 200, { ok:true, dates: [] }); // не валим UI 500-кой
  }
}, { windowMs: 4000, max: 30 });
