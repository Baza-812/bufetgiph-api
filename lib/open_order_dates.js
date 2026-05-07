// Общая логика «открытых для заказа» дат (как GET /api/dates без HTTP).
// Используется в dates.js и feedback.js.

const { atGet, env, TABLE } = require('./utils');

const F_ORG_ID = env('FLD_ORG_ID', 'OrgID');
const F_ORG_TZ = env('FLD_ORG_TZ', 'Time Zone');
const F_ORG_CUTOFF = env('FLD_ORG_CUTOFF', 'Cutoff Time');
const F_ORG_HR_CUTOFF = env('FLD_ORG_HR_CUTOFF', 'HR Cutoff Time');
const DEFAULT_TZ = env('DEFAULT_TZ', 'Europe/Moscow');

const ORGS_TABLE = (TABLE && TABLE.ORGS) || process.env.AIRTABLE_TBL_ORGS || 'Organizations';
const MENU_TABLE = (TABLE && TABLE.MENU) || process.env.AIRTABLE_TBL_MENU || 'Menu';

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
  if (isNaN(dt)) return null;
  return { hh: dt.getUTCHours(), mm: dt.getUTCMinutes() };
}

function canShowDate(nowUtc, deliveryIso, orgRec, hrMode) {
  const tz = orgRec?.fields?.[F_ORG_TZ] || DEFAULT_TZ;
  const ctOrg = parseHHMM(orgRec?.fields?.[F_ORG_CUTOFF]);
  const ctHR = parseHHMM(orgRec?.fields?.[F_ORG_HR_CUTOFF]) || ctOrg;
  const cutoff = hrMode ? ctHR : ctOrg;
  if (!cutoff) return false;

  const [Y, M, D] = deliveryIso.split('-').map(Number);

  let cutoffUtc;
  if (hrMode) {
    cutoffUtc = localToUtc(tz, Y, M, D, cutoff.hh, cutoff.mm);
  } else {
    const prev = new Date(Date.UTC(Y, M - 1, D));
    prev.setUTCDate(prev.getUTCDate() - 1);
    cutoffUtc = localToUtc(
      tz,
      prev.getUTCFullYear(),
      prev.getUTCMonth() + 1,
      prev.getUTCDate(),
      cutoff.hh,
      cutoff.mm
    );
  }

  return nowUtc <= cutoffUtc;
}

/**
 * @param {string} orgCode — OrgID из Organizations
 * @param {boolean} hrMode — как as=hr в /api/dates
 * @returns {{ ok: true, dates: string[], orgRec: object } | { ok: false, error: string }}
 */
async function getOpenOrderDates(orgCode, hrMode = false) {
  const orgResp = await atGet(ORGS_TABLE, {
    filterByFormula: `{${F_ORG_ID}}='${String(orgCode).replace(/'/g, "\\'")}'`,
    maxRecords: 1,
    'fields[]': [F_ORG_ID, F_ORG_TZ, F_ORG_CUTOFF, F_ORG_HR_CUTOFF],
  });
  const orgRec = (orgResp.records || [])[0];
  if (!orgRec) return { ok: false, error: 'organization not found' };

  const menuResp = await atGet(MENU_TABLE, {
    filterByFormula: 'AND({Published}=1)',
    'fields[]': ['Date', 'Published'],
    pageSize: 100,
  });
  const allDates = (menuResp.records || [])
    .map((r) => (r.fields?.Date || '').toString().slice(0, 10))
    .filter(Boolean);

  if (!allDates.length) return { ok: true, dates: [], orgRec };

  const nowUtc = new Date();
  const uniq = Array.from(new Set(allDates));
  const todayIso = new Date().toISOString().slice(0, 10);
  const open = uniq
    .filter((d) => {
      if (d > todayIso) return true;
      if (d < todayIso) return false;
      return canShowDate(nowUtc, d, orgRec, hrMode);
    })
    .sort((a, b) => a.localeCompare(b));

  return { ok: true, dates: open, orgRec };
}

module.exports = { getOpenOrderDates, canShowDate };
