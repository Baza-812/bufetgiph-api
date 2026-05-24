// Общие функции отсечки заказа (как в order.js / order_cancel.js).
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'Europe/Bucharest';

function getTzOffsetMinutes(tz, date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((o) => [o.type, o.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

function localToUtc(tz, y, m, d, hh, mm) {
  const guessUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off = getTzOffsetMinutes(tz, new Date(guessUTC));
  return new Date(guessUTC - off * 60000);
}

function parseHHMM(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return { hh: +m[1], mm: +m[2] };
  }
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return null;
  return { hh: dt.getUTCHours(), mm: dt.getUTCMinutes() };
}

/** UTC-момент отсечки для даты доставки deliveryYmd (YYYY-MM-DD) — накануне в TZ организации. */
function computeCutoffUtcForDeliveryDate(deliveryYmd, orgTz, cutoffRaw) {
  const tz = orgTz || DEFAULT_TZ;
  const ct = parseHHMM(cutoffRaw);
  if (!ct) return null;
  const [Y, M, D] = deliveryYmd.split('-').map(Number);
  const prev = new Date(Date.UTC(Y, M - 1, D));
  prev.setUTCDate(prev.getUTCDate() - 1);
  return localToUtc(tz, prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), ct.hh, ct.mm);
}

/** Сегодняшняя дата YYYY-MM-DD в календаре указанной TZ. */
function todayYmdInTimeZone(tz, instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function addDaysYmd(ymd, k) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + k * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

module.exports = {
  DEFAULT_TZ,
  getTzOffsetMinutes,
  localToUtc,
  parseHHMM,
  computeCutoffUtcForDeliveryDate,
  todayYmdInTimeZone,
  addDaysYmd,
};
