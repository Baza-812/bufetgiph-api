// /lib/handlers/dates.js
// GET /api/dates?org=ORG_CODE[&as=hr]
//  - обычный режим: D доступна до Cutoff в день D-1
//  - HR режим (as=hr): если D=сегодня (в TZ организации) → доступна до HR Cutoff СЕГОДНЯ;
//                      иначе правило выше.
//
// Ответ: { ok: true, dates: ["YYYY-MM-DD", ...] }

const { json, withRateLimit, atGet, TABLE } = require('../../lib/utils');

// Поля Organizations (из вашей базы)
const F_ORG_ID        = 'OrgID';
const F_ORG_TZ        = 'Time Zone';
const F_ORG_CUTOFF    = 'Cutoff Time';
const F_ORG_HR_CUTOFF = 'HR Cutoff Time';

// Дефолты на случай пустых полей
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
function isoUTC(d){ return d.toISOString().slice(0,10); }
function ymdInTz(nowUtc, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  return f.format(nowUtc); // 'YYYY-MM-DD'
}

/**
 * nowUtc — текущий момент в UTC
 * deliveryIso — дата поставки (YYYY-MM-DD)
 * orgRec — запись Organizations
 * useHrCutoff — если true, то для СЕГОДНЯ в TZ организации используем HR cutoff СЕГОДНЯ,
 *               для остальных дат — окно закрывается накануне по (HR|обычному) cutoff.
 */
function canOrderForDate(nowUtc, deliveryIso, orgRec, useHrCutoff){
  const tz = (orgRec?.fields?.[F_ORG_TZ]) || DEFAULT_TZ;

  const normalCutoffStr = orgRec?.fields?.[F_ORG_CUTOFF]    || DEFAULT_CUTOFF;
  const hrCutoffStr     = orgRec?.fields?.[F_ORG_HR_CUTOFF] || normalCutoffStr;

  const todayLocalIso = ymdInTz(nowUtc, tz);
  const [Y,M,D] = deliveryIso.split('-').map(Number);

  // HR-режим: если дата = СЕГОДНЯ в TZ организации → закрытие СЕГОДНЯ в HR Cutoff
  if (useHrCutoff && deliveryIso === todayLocalIso) {
    const ct = parseHHMM(hrCutoffStr);
    if (!ct) return true; // не режем при некорректном формате, чтобы не ломать UI
    const cutoffTodayUtc = localToUtc(tz, Y, M, D, ct.hh, ct.mm);
    return nowUtc <= cutoffTodayUtc;
  }

  // Иначе — закрытие НА НАКАНУНЕ в соответствующий cutoff (HR/обычный)
  const cutoffStr = useHrCutoff ? hrCutoffStr : normalCutoffStr;
  const ct = parseHHMM(cutoffStr);
  if (!ct) {
    // fallback: не показываем прошедшие даты
    const todayUTC = isoUTC(new Date());
    return deliveryIso >= todayUTC;
  }

  const prev = new Date(Date.UTC(Y, M-1, D)); // день поставки в UTC
  prev.setUTCDate(prev.getUTCDate()-1);       // накануне

  const cutoffPrevUtc = localToUtc(
    tz,
    prev.getUTCFullYear(),
    prev.getUTCMonth()+1,
    prev.getUTCDate(),
    ct.hh,
    ct.mm
  );

  return nowUtc <= cutoffPrevUtc;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { ok:false, error:'GET only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');
    const as  = (url.searchParams.get('as') || '').toLowerCase();
    if (!org) return json(res, 400, { ok:false, error:'org required' });

    // 1) Организация: тянем TZ и cutoffs
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F_ORG_ID}}='${org}'`,
      "fields[]": [F_ORG_ID, F_ORG_TZ, F_ORG_CUTOFF, F_ORG_HR_CUTOFF],
      maxRecords: 1
    });
    const orgRec = (orgResp.records || [])[0];
    if (!orgRec) return json(res, 200, { ok:true, dates: [] });

    const useHrCutoff = (as === 'hr');

    // 2) Публикации меню
    const menuResp = await atGet(TABLE.MENU, {
      filterByFormula: `AND({Published}=1)`,
      "fields[]": ["Date", "Published"],
      pageSize: 200
    });

    const allDates = (menuResp.records || [])
      .map(r => (r.fields?.['Date'] || '').toString().slice(0,10))
      .filter(Boolean);

    const unique = Array.from(new Set(allDates)).sort((a,b)=> a.localeCompare(b));
    if (!unique.length) return json(res, 200, { ok:true, dates: [] });

    const nowUtc = new Date();
    const dates = unique.filter(d => canOrderForDate(nowUtc, d, orgRec, useHrCutoff));

    return json(res, 200, { ok:true, dates });
  } catch (e) {
    console.error('DATES_ERROR', e?.message || e);
    // Не валим UI 500-й — лучше пустой список
    return json(res, 200, { ok:true, dates: [] });
  }
}, { windowMs: 4000, max: 30 });
