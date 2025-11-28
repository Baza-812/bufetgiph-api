// lib/handlers/employee_meta.js — метаданные сотрудника

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  EMPLOYEES: env('TBL_EMPLOYEES', 'Employees'),
};

const F = {
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),
  EMP_ROLE:       env('FLD_EMP_ROLE',       'Role'),
  EMP_FULL_NAME:  env('FLD_EMP_FULL_NAME',  'FullName'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

const atHeaders = () => ({ Authorization: `Bearer ${APIKEY}`, 'Content-Type': 'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(t, params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(vv => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a) => (Array.isArray(a) && a.length ? a[0] : null);

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    if (!BASE || !APIKEY) return json(res, 500, { error: 'Missing AIRTABLE_* env' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const employeeID = url.searchParams.get('employeeID');
    const org = url.searchParams.get('org');
    const token = url.searchParams.get('token');

    if (!employeeID || !org || !token) {
      return json(res, 400, { error: 'employeeID, org, token required' });
    }

    // Получаем сотрудника
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      maxRecords: 1,
      'fields[]': [
        F.EMP_ORG_LOOKUP,
        F.EMP_TOKEN,
        F.EMP_STATUS,
        F.EMP_ROLE,
        F.EMP_FULL_NAME,
      ],
    });

    const empRec = one(empResp.records);
    if (!empRec) return json(res, 404, { error: 'employee not found' });

    const ef = empRec.fields || {};

    // Проверка org
    const empOrg = (Array.isArray(ef[F.EMP_ORG_LOOKUP]) ? ef[F.EMP_ORG_LOOKUP][0] : ef[F.EMP_ORG_LOOKUP]) || null;
    if (empOrg !== org) return json(res, 403, { error: 'employee not allowed (org mismatch)' });

    // Проверка токена
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) {
      return json(res, 403, { error: 'invalid token' });
    }

    // Проверка статуса
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase() !== 'active') {
      return json(res, 403, { error: 'employee not active' });
    }

    const role = ef[F.EMP_ROLE] || 'Employee';
    const fullName = ef[F.EMP_FULL_NAME] || '';

    return json(res, 200, {
      ok: true,
      employeeID: empRec.id,
      role,
      fullName,
      organization: org,
    });

  } catch (e) {
    console.error('employee_meta.js failed:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
