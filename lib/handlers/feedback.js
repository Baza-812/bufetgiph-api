// GET /api/feedback?employeeID=&org=&token=
// POST /api/feedback  JSON { employeeID, org, token, date, rating, comment? }

const { json, withRateLimit, atGet, atPost, one, TABLE, F } = require('../utils');
const { getOpenOrderDates } = require('../open_order_dates');

const TBL_ORDERS = TABLE.ORDERS || 'Orders';
const TBL_ORGS = TABLE.ORGS || 'Organizations';
const TBL_EMPLOYEES = TABLE.EMPLOYEES || 'Employees';
const FB_TABLE = process.env.TBL_MEAL_FEEDBACK || 'MealFeedback';

const ORD_DATE_ISO = 'OrderDateISO';
const ORD_DATE_DT = 'Order Date';
const ORD_TYPE = 'Order Type';
const ORD_EMP = 'Employee';
const ORD_ORG = 'Org';
const ORD_ORG_IDS = 'Org IDs';
const ORD_STATUS = 'Status';

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

  {
    const filter = `AND(${dCond}, ${notCancelled}, ${typeCond}, {${ORD_ORG}}='${orgRecId}')`;
    const rec = await fetchOrdersAndPickEmployee(filter, [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP], employeeId);
    if (rec) return rec;
  }
  try {
    const orgIdsCond = `OR(
      ${eqStr(ORD_ORG_IDS, orgRecId)},
      FIND('${orgRecId}', {${ORD_ORG_IDS}}),
      FIND('${orgRecId}', ARRAYJOIN({${ORD_ORG_IDS}}))
    )`;
    const filter = `AND(${dCond}, ${notCancelled}, ${typeCond}, ${orgIdsCond})`;
    const rec = await fetchOrdersAndPickEmployee(filter, [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP], employeeId);
    if (rec) return rec;
  } catch {
    /* no field */
  }
  {
    const filter = `AND(${dCond}, ${notCancelled}, ${typeCond})`;
    const rec = await fetchOrdersAndPickEmployee(filter, [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP], employeeId);
    if (rec) return rec;
  }
  return null;
}

/** Последние до 5 дат с заказом, для которых приём заказов уже закрыт (дата не в openOrderDates). */
function cutoffIsoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function computeEligibleFeedbackDates(employeeID, orgRecId, openOrderDatesSet) {
  const typeCond = `OR(LEN({${ORD_TYPE}})=0, LOWER({${ORD_TYPE}})='employee')`;
  const notCancelled = `NOT(OR(LOWER({${ORD_STATUS}})='cancelled',LOWER({${ORD_STATUS}})='canceled',LOWER({${ORD_STATUS}})='deleted'))`;
  const empCond = `SEARCH('${employeeID}', ARRAYJOIN({${ORD_EMP}})) > 0`;
  const orgFilter = `{${ORD_ORG}}='${orgRecId}'`;
  const minIso = cutoffIsoDaysAgo(120);
  let filter = `AND(${empCond}, ${notCancelled}, ${typeCond}, ${orgFilter})`;

  let r;
  try {
    r = await atGet(TBL_ORDERS, {
      filterByFormula: filter,
      'fields[]': [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP, ORD_ORG],
      pageSize: 100,
    });
  } catch {
    r = { records: [] };
  }

  let records = r.records || [];
  if (!records.length) {
    try {
      const orgIdsCond = `OR(
        ${eqStr(ORD_ORG_IDS, orgRecId)},
        FIND('${orgRecId}', {${ORD_ORG_IDS}}),
        FIND('${orgRecId}', ARRAYJOIN({${ORD_ORG_IDS}}))
      )`;
      filter = `AND(${empCond}, ${notCancelled}, ${typeCond}, ${orgIdsCond})`;
      r = await atGet(TBL_ORDERS, {
        filterByFormula: filter,
        'fields[]': [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP, ORD_ORG],
        pageSize: 100,
      });
      records = r.records || [];
    } catch {
      records = [];
    }
  }

  if (!records.length) {
    filter = `AND(${empCond}, ${notCancelled}, ${typeCond})`;
    r = await atGet(TBL_ORDERS, {
      filterByFormula: filter,
      'fields[]': [ORD_DATE_ISO, ORD_DATE_DT, ORD_EMP],
      pageSize: 100,
    });
    records = r.records || [];
  }

  const withIso = [];
  for (const rec of records) {
    const iso = orderMealIso(rec.fields || {});
    if (!iso || iso < minIso) continue;
    withIso.push(iso);
  }

  const unique = Array.from(new Set(withIso));
  const closed = unique.filter((d) => !openOrderDatesSet.has(d));
  closed.sort((a, b) => b.localeCompare(a));
  return closed.slice(0, 5);
}

async function loadFeedbackSubmitted(employeeID, eligibleDates) {
  const submitted = {};
  for (const d of eligibleDates) submitted[d] = false;
  if (!eligibleDates.length) return submitted;

  try {
    const empCond = `SEARCH('${employeeID}', ARRAYJOIN({${FB_EMP}})) > 0`;
    const r = await atGet(FB_TABLE, {
      filterByFormula: empCond,
      'fields[]': [FB_DATE, FB_RATING],
      pageSize: 100,
    });
    const setEl = new Set(eligibleDates);
    for (const rec of r.records || []) {
      const meal = (rec.fields?.[FB_DATE] || '').toString().trim().slice(0, 10);
      if (setEl.has(meal)) submitted[meal] = true;
    }
  } catch (e) {
    console.warn('[feedback] loadFeedbackSubmitted:', e?.message || e);
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
