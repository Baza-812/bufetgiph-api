// /lib/handlers/dates.js
// Вернёт только даты с Published=1, для которых ещё открыто окно заказа:
// - сегодня (если текущее время <= cutoff для этой org)
// - все будущие даты
//
// Запрос: GET /api/dates?org=org120
// Ответ:  { ok: true, dates: ["YYYY-MM-DD", ...] }

const { json, withRateLimit, atGet, env, TABLE } = require('../../lib/utils');

// Имена полей Organizations такие же, как в order.js (можно переопределить env-переменными)
const F_ORG_ID     = env('FLD_ORG_ID',        'OrgID');
const F_ORG_TZ     = env('FLD_ORG_TZ',        'Time Zone');
const F_ORG_CUTOFF = env('FLD_ORG_CUTOFF',    'Cutoff Time');
const DEFAULT_TZ   = env('DEFAULT_TZ',        'Europe/Bucharest');

// ---- Вспомогательные функции времени (как в order.js)
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
    const m = v.match(/^(\d{1,2}):(\d{2})/); if (!m) return null;
    return {hh:+m[1], mm:+m[2]};
  }
  const dt = new Date(v); if (isNaN(dt)) return null;
  return { hh: dt.getUTCHours(), mm: dt.getUTCMinutes() };
}
function canOrderForDate(nowUtc, deliveryIso, orgRec){
  const tz = (orgRec?.fields?.[F_ORG_TZ]) || DEFAULT_TZ;
  const ct = parseHHMM(orgRec?.fields?.[F_ORG_CUTOFF]);
  if (!ct) return false;

  const [Y,M,D] = deliveryIso.split('-').map(Number);
  // cutoff для «вчера в локали» (как в order.js)
  const prev = new Date(Date.UTC(Y, M-1, D)); prev.setUTCDate(prev.getUTCDate()-1);
  const cutoffUtc = localToUtc(tz, prev.getUTCFullYear(), prev.getUTCMonth()+1, prev.getUTCDate(), ct.hh, ct.mm);

  // если текущий момент <= cutoff — дату показываем
  return nowUtc <= cutoffUtc;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'GET')     return json(res, 405, { error: 'GET only' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const org = url.searchParams.get('org');
    if (!org) return json(res, 400, { ok:false, error:'org required' });

    // 1) Находим org (таймзона и cutoff)
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F_ORG_ID}}='${org}'`,
      maxRecords: 1,
      "fields[]": [F_ORG_ID, F_ORG_TZ, F_ORG_CUTOFF]
    });
    const orgRec = (orgResp.records || [])[0];
    if (!orgRec) return json(res, 400, { ok:false, error:'organization not found' });

    // 2) Берём все опубликованные даты из Menu
    const resp = await atGet(TABLE.MENU, {
      filterByFormula: `AND({Published}=1)`,
      "fields[]": ["Date", "Published"],
      pageSize: 100
    });
    const allDates = (resp.records || [])
      .map(r => (r.fields?.["Date"] || '').toString().slice(0, 10))
      .filter(Boolean);

    // 3) Оставляем только те, для которых сейчас «окно открыто»
    const nowUtc = new Date();
    const unique = Array.from(new Set(allDates));
    const openDates = unique.filter(d => canOrderForDate(nowUtc, d, orgRec))
                            .sort((a,b)=> a.localeCompare(b));

    return json(res, 200, { ok: true, dates: openDates });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || String(e) });
  }
}, { windowMs: 4000, max: 30 });
