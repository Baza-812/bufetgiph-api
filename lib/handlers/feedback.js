// GET /api/feedback?employeeID=&org=&token=
// POST /api/feedback  JSON { employeeID, org, token, date, rating, comment? }

const { json, withRateLimit, atGet, atPost, one, TABLE, F } = require('../utils');
const { getOpenOrderDates } = require('../open_order_dates');

const TBL_ORDERS = TABLE.ORDERS || 'Orders';
const TBL_ORGS = TABLE.ORGS || 'Organizations';
const TBL_EMPLOYEES = TABLE.EMPLOYEES || 'Employees';
const FB_TABLE = process.env.TBL_MEAL_FEEDBACK || 'MealFeedback';

const ORD_DATE_ISO = (process.env.FLD_ORDER_DATE_ISO || '').trim() || 'OrderDateISO';
const ORD_DATE_DT = F.ORDER_DATE;
const ORD_TYPE = F.ORDER_TYPE;
const ORD_EMP = F.ORDER_EMPLOYEE;
const F_ORDER_EMPLOYEEID = (process.env.FLD_ORDER_EMPLOYEEID || '').trim();
const ORD_ORG = 'Org';
const ORD_ORG_IDS = 'Org IDs';
const ORD_STATUS = F.ORDER_STATUS;

const FB_EMP = process.env.FLD_FB_EMPLOYEE || 'Employee';
const FB_ORG = process.env.FLD_FB_ORG || 'Organization';
const FB_DATE = process.env.FLD_FB_MEAL_DATE || 'MealDate';
const FB_RATING = process.env.FLD_FB_RATING || 'Rating';
const FB_COMMENT = process.env.FLD_FB_COMMENT || 'Comment';

const RATINGS = ['Очень плохо', 'Плохо', 'Нормально', 'Хорошо', 'Отлично'];
const RATING_SET = new Set(RATINGS);

const eqStr = (field, val) => `{${field}}='${String(val).replace(/'/g, "\\'")}'`;

const dateCondOrders = (dateISO) =>
  `OR({${ORD_DATE_ISO}}='${dateISO}', DATETIME_FORMAT({${ORD_DATE_DT}}, 'YYYY-MM-DD')='${dateISO}')`;

function orderMealIso(fields) {
  const iso = (fields[ORD_DATE_ISO] || '').toString().trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const dt = fields[ORD_DATE_DT];
  if (dt) return new Date(dt).toISOString().slice(0, 10);
  return '';
}

/** Как busy.js: связь Employee + опционально текстовый FLD_ORDER_EMPLOYEEID */
function employeeOrderCond(employeeID) {
  const esc = String(employeeID).replace(/'/g, "\\'");
  const byLink = `SEARCH('${esc}', ARRAYJOIN({${ORD_EMP}})) > 0`;
  if (F_ORDER_EMPLOYEEID) {
    return `OR(${byLink}, {${F_ORDER_EMPLOYEEID}}='${esc}')`;
  }
  return byLink;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function getOrgRecIdByCode(orgCode) {
  const r = await atGet(TBL_ORGS, {
    filterByFormula: eqStr(F.ORG_ID, orgCode),
    'fields[]': [],
    maxRecords: 1,
    pageSize: 1,
  });
  return (r.records && r.records[0] && r.records[0].id) || null;
}

async function assertEmployeeAuth(employeeID, org, token) {
  const empResp = await atGet(TBL_EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${employeeID}'`,
    'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS, F.EMP_NAME],
    maxRecords: 1,
  });
  const employee = one(empResp.records);
  if (!employee) return { ok: false, code: 404, error: 'Employee not found' };

  const ef = employee.fields || {};
  const empOrg = Array.isArray(ef[F.EMP_ORG_LOOKUP]) ? ef[F.EMP_ORG_LOOKUP][0] : ef[F.EMP_ORG_LOOKUP];
  if (empOrg !== org) return { ok: false, code: 403, error: 'Organization mismatch' };
  if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) return { ok: false, code: 403, error: 'Invalid token' };
  if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase() !== 'active') {
    return { ok: false, code: 403, error: 'Employee not active' };
  }
  return { ok: true, employee };
}

function orderBelongsToOrg(fields, orgRecId) {
  if (!orgRecId) return false;
  const link = fields[ORD_ORG];
  const ids = Array.isArray(link) ? link : link ? [link] : [];
  if (ids.length) return ids.includes(orgRecId);

  const raw = fields[ORD_ORG_IDS];
  if (raw != null && String(raw).trim() !== '') {
    const s = Array.isArray(raw) ? raw.join(' ') : String(raw);
    return s.includes(orgRecId);
  }

  // Поле Org в Orders часто lookup — в API не приходит; заказ уже отфильтрован по Employee
  return true;
}

async function fetchOrdersAndPickEmployee(filter, fields, employeeId) {
  const r = await atGet(TBL_ORDERS, {
    filterByFormula: filter,
    'fields[]': fields,
    pageSize: 100,
  });
  const list = r.records || [];
  if (!list.length) return null;
  return (
    list.find((o) => {
      const link = o.fields?.[ORD_EMP];
      const ids = Array.isArray(link) ? link : link ? [link] : [];
      return ids.includes(employeeId);
    }) || null
  );
}

async function findEmployeeOrderOnDate(dateISO, orgRecId, employeeId) {
  const typeCond = `OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee')`;
  const notCancelled = `NOT(OR(LOWER({${ORD_STATUS}})='cancelled',LOWER({${ORD_STATUS}})='canceled',LOWER({${ORD_STATUS}})='deleted'))`;
  const dCond = dateCondOrders(dateISO);
  const filter = `AND(${dCond}, ${notCancelled}, ${typeCond}, ${employeeOrderCond(employeeId)})`;
  const rec = await fetchOrdersAndPickEmployee(
    filter,
    [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP, ORD_ORG, ORD_ORG_IDS],
    employeeId
  );
  if (!rec) return null;
  if (!orderBelongsToOrg(rec.fields || {}, orgRecId)) return null;
  return rec;
}

/** Последние до 5 дат с заказом, для которых приём заказов уже закрыт (дата не в openOrderDates). */
function cutoffIsoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function listOrdersForFeedback(employeeID, baseFields) {
  const typeCond = `OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee')`;
  const notCancelled = `NOT(OR(LOWER({${ORD_STATUS}})='cancelled',LOWER({${ORD_STATUS}})='canceled',LOWER({${ORD_STATUS}})='deleted'))`;
  const filter = `AND(${employeeOrderCond(employeeID)}, ${notCancelled}, ${typeCond})`;
  const base = { filterByFormula: filter, 'fields[]': baseFields, pageSize: 100 };
  const sorts = [
    { 'sort[0][field]': ORD_DATE_DT, 'sort[0][direction]': 'desc' },
    { 'sort[0][field]': ORD_DATE_ISO, 'sort[0][direction]': 'desc' },
  ];
  for (const sp of sorts) {
    try {
      const r = await atGet(TBL_ORDERS, { ...base, ...sp });
      return r.records || [];
    } catch (e) {
      console.warn('[feedback] listOrders sort', sp['sort[0][field]'], e?.message || e);
    }
  }
  try {
    const r = await atGet(TBL_ORDERS, base);
    return r.records || [];
  } catch (e) {
    console.warn('[feedback] listOrders', e?.message || e);
    return [];
  }
}

/**
 * Даты с заказом, где приём на эту дату уже закрыт: дата ∉ openOrderDates
 * (тот же смысл, что «серый» календарь /api/dates). Без отсечения по UTC —
 * иначе у TZ впереди UTC «вчерашние» обеды отбрасывались.
 */
async function computeEligibleFeedbackDates(employeeID, orgRecId, openOrderDatesSet) {
  const minIso = cutoffIsoDaysAgo(120);
  const baseFields = [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP, ORD_ORG, ORD_ORG_IDS];
  const records = await listOrdersForFeedback(employeeID, baseFields);

  const withIso = [];
  for (const rec of records) {
    if (!orderBelongsToOrg(rec.fields || {}, orgRecId)) continue;
    const iso = orderMealIso(rec.fields || {});
    if (!iso || iso < minIso) continue;
    withIso.push(iso);
  }

  const unique = Array.from(new Set(withIso));
  const closed = unique.filter((d) => !openOrderDatesSet.has(d));
  closed.sort((a, b) => b.localeCompare(a));
  return closed.slice(0, 5);
}

/** Дата в MealFeedback: текст YYYY-MM-DD, поле Date в Airtable или ISO-строка */
function mealFeedbackDateIso(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string') {
    const s = raw.trim();
    const head = s.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
    const m = s.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const t = Date.parse(String(raw));
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return String(raw).trim().slice(0, 10);
}

function feedbackRecordHasEmployee(fields, employeeID) {
  const link = fields[FB_EMP];
  if (link == null) return false;
  const ids = Array.isArray(link) ? link : [link];
  return ids.some((id) => id === employeeID || String(id) === String(employeeID));
}

/**
 * Загрузка флагов «уже отправлено». Не полагаемся только на SEARCH по связи Employee в формуле
 * (в разных базах ARRAYJOIN ведёт себя по-разному). Сначала узкий фильтр по MealDate, потом JS по Employee.
 */
async function loadFeedbackSubmitted(employeeID, eligibleDates) {
  const submitted = {};
  for (const d of eligibleDates) submitted[d] = false;
  if (!eligibleDates.length) return submitted;

  const setEl = new Set(eligibleDates);
  const esc = String(employeeID).replace(/'/g, "\\'");
  const fields = [FB_EMP, FB_DATE, FB_RATING];

  function applyRecords(records) {
    for (const rec of records || []) {
      const f = rec.fields || {};
      if (!feedbackRecordHasEmployee(f, employeeID)) continue;
      const meal = mealFeedbackDateIso(f[FB_DATE]);
      if (meal && setEl.has(meal)) submitted[meal] = true;
    }
  }

  async function fetchAllByFormula(filterByFormula) {
    const out = [];
    let offset;
    for (let page = 0; page < 10; page += 1) {
      const params = {
        filterByFormula,
        'fields[]': fields,
        pageSize: 100,
      };
      if (offset) params.offset = offset;
      const r = await atGet(FB_TABLE, params);
      out.push(...(r.records || []));
      offset = r.offset;
      if (!offset) break;
    }
    return out;
  }

  const dateTextOr =
    eligibleDates.length === 1
      ? eqStr(FB_DATE, eligibleDates[0])
      : `OR(${eligibleDates.map((d) => eqStr(FB_DATE, d)).join(',')})`;

  const dateSameOr =
    eligibleDates.length === 1
      ? `IS_SAME({${FB_DATE}}, '${eligibleDates[0]}', 'day')`
      : `OR(${eligibleDates.map((d) => `IS_SAME({${FB_DATE}}, '${d}', 'day')`).join(',')})`;

  const empFormulas = [
    `SEARCH('${esc}', ARRAYJOIN({${FB_EMP}})) > 0`,
    `FIND('${esc}', ARRAYJOIN({${FB_EMP}})) > 0`,
    `{${FB_EMP}} = '${esc}'`,
  ];

  const strategies = [
    { name: 'mealDate_text', formula: dateTextOr },
    { name: 'mealDate_is_same', formula: dateSameOr },
    ...empFormulas.map((formula) => ({ name: 'employee', formula })),
  ];

  for (const { name, formula } of strategies) {
    try {
      const records = await fetchAllByFormula(formula);
      applyRecords(records);
      if (Object.values(submitted).some(Boolean)) {
        return submitted;
      }
    } catch (e) {
      console.warn(`[feedback] loadFeedbackSubmitted ${name}:`, e?.message || e);
    }
  }

  return submitted;
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const employeeID = String(url.searchParams.get('employeeID') || '').trim();
      const org = String(url.searchParams.get('org') || '').trim();
      const token = String(url.searchParams.get('token') || '').trim();

      if (!employeeID || !org || !token) {
        return json(res, 400, { ok: false, error: 'employeeID, org, token required' });
      }

      const auth = await assertEmployeeAuth(employeeID, org, token);
      if (!auth.ok) return json(res, auth.code, { ok: false, error: auth.error });

      const open = await getOpenOrderDates(org, false);
      if (!open.ok) return json(res, 404, { ok: false, error: open.error || 'organization not found' });

      const orgRecId = await getOrgRecIdByCode(org);
      if (!orgRecId) return json(res, 404, { ok: false, error: 'organization not found' });

      const openSet = new Set(open.dates);
      const eligibleDates = await computeEligibleFeedbackDates(employeeID, orgRecId, openSet);
      const feedbackSubmitted = await loadFeedbackSubmitted(employeeID, eligibleDates);

      return json(res, 200, {
        ok: true,
        eligibleDates,
        feedbackSubmitted,
      });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid JSON' });
      }

      const employeeID = String(body.employeeID || '').trim();
      const org = String(body.org || '').trim();
      const token = String(body.token || '').trim();
      const date = String(body.date || '').trim().slice(0, 10);
      const rating = String(body.rating || '').trim();
      const comment = String(body.comment ?? '').trim();

      if (!employeeID || !org || !token) {
        return json(res, 400, { ok: false, error: 'employeeID, org, token required' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json(res, 400, { ok: false, error: 'invalid date' });
      }
      if (!RATING_SET.has(rating)) {
        return json(res, 400, { ok: false, error: 'invalid rating', allowed: RATINGS });
      }
      if (comment.length > 300) {
        return json(res, 400, { ok: false, error: 'comment too long', max: 300 });
      }

      const auth = await assertEmployeeAuth(employeeID, org, token);
      if (!auth.ok) return json(res, auth.code, { ok: false, error: auth.error });

      const open = await getOpenOrderDates(org, false);
      if (!open.ok) return json(res, 404, { ok: false, error: open.error || 'organization not found' });

      const orgRecId = await getOrgRecIdByCode(org);
      if (!orgRecId) return json(res, 404, { ok: false, error: 'organization not found' });

      const openSet = new Set(open.dates);
      const eligibleDates = await computeEligibleFeedbackDates(employeeID, orgRecId, openSet);
      if (!eligibleDates.includes(date)) {
        return json(res, 403, { ok: false, error: 'date not eligible for feedback' });
      }

      const orderRec = await findEmployeeOrderOnDate(date, orgRecId, employeeID);
      if (!orderRec) {
        return json(res, 403, { ok: false, error: 'no order on this date' });
      }

      const existing = await loadFeedbackSubmitted(employeeID, [date]);
      if (existing[date]) {
        return json(res, 409, { ok: false, error: 'feedback already submitted for this date' });
      }

      const fields = {
        [FB_EMP]: [employeeID],
        [FB_ORG]: [orgRecId],
        [FB_DATE]: date,
        [FB_RATING]: rating,
      };
      if (comment) fields[FB_COMMENT] = comment;

      await atPost(FB_TABLE, {
        typecast: true,
        records: [{ fields }],
      });

      return json(res, 200, { ok: true });
    }

    return json(res, 405, { ok: false, error: 'GET or POST only' });
  } catch (err) {
    console.error('[feedback]', err);
    return json(res, 500, { ok: false, error: err.message || String(err) });
  }
}, { windowMs: 4000, max: 40 });
