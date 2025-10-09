// /lib/handlers/dates.js
// Даты для выбора:
// - Всегда будущие опубликованные даты из Menu
// - Плюс «сегодня», если текущее время <= Cutoff Time (для as=hr — HR Cutoff Time)
//
// GET /api/dates?org=org120[&as=hr]
// => { ok:true, dates:["YYYY-MM-DD", ...] }

const { json, withRateLimit, atGet, env, TABLE } = require('../utils'); // путь от router.js: '../lib/utils'
const isPreview = (process.env.VERCEL_ENV || process.env.NODE_ENV) === 'preview';

// Поля Organizations (совпадают со структурой)
const F_ORG_ID        = env('FLD_ORG_ID',        'OrgID');
const F_ORG_TZ        = env('FLD_ORG_TZ',        'Time Zone');
const F_ORG_CUTOFF    = env('FLD_ORG_CUTOFF',    'Cutoff Time');
const F_ORG_HR_CUTOFF = env('FLD_ORG_HR_CUTOFF', 'HR Cutoff Time');

const DEFAULT_TZ = env('DEFAULT_TZ', 'Europe/Moscow');

// Таблицы с фолбэками (если в utils нет маппинга или ENV не заданы)
const ORGS_TABLE = (TABLE && TABLE.ORGS) || process.env.AIRTABLE_TBL_ORGS || 'Organizations';
const MENU_TABLE = (TABLE && TABLE.MENU) || process.env.AIRTABLE_TBL_MENU || 'Menu';

// ---- Время/таймзона (как в order.js)
function getTzOffsetMinutes(tz, date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const p = Object.fromEntries(f.formatToParts(date).map(o => [o.type, o.value]));
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
    const m = v.match(/^(\d{1,2}):(\d{2})/); if (!m) return null;
    return {hh:+m[1], mm:+m[2]};
  }
  const dt = new Date(v); if (isNaN(dt)) return null;
  return { hh: dt.getUTCHours(), mm: dt.getUTCMinutes() };
}

// Решение на «сегодня»:
// - для обычных пользователей: cutoff = Cutoff Time «вчера в локали»
// - для HR (as=hr): cutoff = HR Cutoff Time «сегодня в локали»
function canShowDate(nowUtc, deliveryIso, orgRec, hrMode){
  const tz = (orgRec?.fields?.[F_ORG_TZ]) || DEFAULT_TZ;
  const ctOrg = parseHHMM(orgRec?.fields?.[F_ORG_CUTOFF]);
  const ctHR  = parseHHMM(orgRec?.fields?.[F_ORG_HR_CUTOFF]) || ctOrg; // если HR пуст — используем обычный
  const cutoff = hrMode ? ctHR : ctOrg;
  if (!cutoff) return false;

  const [Y,M,D] = deliveryIso.split('-').map(Number);

  let cutoffUtc;
  if (hrMode) {
    // HR — «сегодня в локали»
    cutoffUtc = localToUtc(tz, Y, M, D, cutoff.hh, cutoff.mm);
  } else {
    // обычный — «вчера в локали»
    const prev = new Date(Date.UTC(Y, M-1, D)); prev.setUTCDate(prev.getUTCDate()-1);
    cutoffUtc = localToUtc(tz, prev.getUTCFullYear(), prev.getUTCMonth()+1, prev.getUTCDate(), cutoff.hh, cutoff.mm);
  }

  return nowUtc <= cutoffUtc;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');
    const as  = (url.searchParams.get('as') || '').toLowerCase();
    const hrMode = as === 'hr';

    if (!org) return json(res, 400, { ok:false, error:'org required' });

    // 1) Организация (таймзона и cutoff’ы)
    const orgResp = await atGet(ORGS_TABLE, {
      filterByFormula: `{${F_ORG_ID}}='${org}'`,
      maxRecords: 1,
      "fields[]": [F_ORG_ID, F_ORG_TZ, F_ORG_CUTOFF, F_ORG_HR_CUTOFF]
    });
    const orgRec = (orgResp.records || [])[0];
    if (!orgRec) return json(res, 404, { ok:false, error:'organization not found' });

    // 2) Опубликованные даты из Menu
    const menuResp = await atGet(MENU_TABLE, {
      filterByFormula: `AND({Published}=1)`,
      "fields[]": ["Date", "Published"],
      pageSize: 100
    });
    const allDates = (menuResp.records || [])
      .map(r => (r.fields?.["Date"] || '').toString().slice(0,10))
      .filter(Boolean);

    if (!allDates.length) return json(res, 200, { ok: true, dates: [] });

    // 3) Фильтр по «окну» + сортировка + уникализация
    const nowUtc = new Date();
    const uniq = Array.from(new Set(allDates));
    const open = uniq
      .filter(d => {
        // Будущее всегда видно
        const todayIso = new Date().toISOString().slice(0,10);
        if (d > todayIso) return true;
        if (d < todayIso) return false;
        // d == today -> проверяем соответствующий cutoff
        return canShowDate(nowUtc, d, orgRec, hrMode);
      })
      .sort((a,b)=>a.localeCompare(b));

    return json(res, 200, { ok: true, dates: open });
  } catch (e) {
    // В превью помогаем диагностировать причиной
    const msg = e?.message || String(e);
    return json(res, isPreview ? 500 : 200, { ok: !isPreview, error: msg, dates: isPreview ? undefined : [] });
  }
}, { windowMs: 4000, max: 30 });
