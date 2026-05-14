// lib/handlers/employee_info.js
// Получение информации о сотруднике

const { json, withRateLimit, atGet, one, TABLE, F } = require('../utils');
const { findDinnerCloneEmployeeId } = require('../dinner_clone');

module.exports = withRateLimit(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const { employeeID, org, token } = req.query;

    if (!employeeID || !org || !token) {
      return json(res, 400, { error: 'employeeID, org, token required' });
    }

    // Получаем сотрудника
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      'fields[]': [
        F.EMP_NAME,
        F.EMP_ORG_LOOKUP,
        F.EMP_TOKEN,
        F.EMP_STATUS,
        F.EMP_ROLE,
        F.EMP_DINNER,
        F.EMP_DINNER_TYPE,
      ],
      maxRecords: 1
    });

    const employee = one(empResp.records);
    if (!employee) {
      return json(res, 404, { error: 'Employee not found' });
    }

    const ef = employee.fields || {};
    const empOrg = Array.isArray(ef[F.EMP_ORG_LOOKUP]) 
      ? ef[F.EMP_ORG_LOOKUP][0] 
      : ef[F.EMP_ORG_LOOKUP];
    
    // Проверка org
    if (empOrg !== org) {
      return json(res, 403, { error: 'Organization mismatch' });
    }

    // Проверка token
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) {
      return json(res, 403, { error: 'Invalid token' });
    }

    // Проверка статуса
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase() !== 'active') {
      return json(res, 403, { error: 'Employee not active' });
    }

    const roleRaw = ef[F.EMP_ROLE] != null ? String(ef[F.EMP_ROLE]) : 'Employee';

    const dinnerRaw = ef[F.EMP_DINNER];
    const dinnerEnabled = dinnerRaw === true || String(dinnerRaw).toLowerCase() === 'true' || String(dinnerRaw).toLowerCase() === 'yes';
    const dinnerType = String(ef[F.EMP_DINNER_TYPE] || '').trim();
    let dinnerEmployeeId = '';
    if (dinnerEnabled) {
      try {
        dinnerEmployeeId = (await findDinnerCloneEmployeeId(employeeID)) || '';
      } catch (e) {
        console.warn('[employee_info] dinner clone lookup failed:', e?.message || e);
      }
    }

    return json(res, 200, {
      ok: true,
      fullName: ef[F.EMP_NAME] || '',
      role: roleRaw.trim() || 'Employee',
      dinner: dinnerEnabled,
      dinnerType: dinnerType || '',
      dinnerEmployeeId: dinnerEmployeeId || '',
    });

  } catch (err) {
    console.error('employee_info error:', err);
    return json(res, 500, { 
      ok: false, 
      error: err.message || String(err) 
    });
  }
}, { windowMs: 4000, max: 30 });
