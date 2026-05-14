// lib/dinner_clone.js — клон сотрудника «ужин»: ссылка на основного в Employees.
const { atGet, one, listAll, TABLE, F } = require('./utils');

function linkFieldArray(val) {
  if (Array.isArray(val)) return val.filter(Boolean);
  return val ? [val] : [];
}

function escapeSingleQuotes(s) {
  return String(s || '').replace(/'/g, "\\'");
}

function isActiveEmployeeStatus(st) {
  return !st || String(st).toLowerCase() === 'active';
}

function cloneRecordsLinkedToPrimary(records, linkFieldName, primaryId) {
  return (records || []).filter((rec) => {
    const links = linkFieldArray(rec.fields?.[linkFieldName]);
    return links.includes(primaryId);
  });
}

function pickSingleActiveClone(records, primaryIdForLog = '') {
  const active = (records || []).filter((rec) => isActiveEmployeeStatus(rec.fields?.[F.EMP_STATUS]));
  if (active.length > 1) {
    console.warn('[dinner_clone] multiple active dinner clones for primary', primaryIdForLog);
    return null;
  }
  if (active.length === 1) return active[0].id;
  if ((records || []).length > 0) {
    console.warn('[dinner_clone] dinner clone linked but none active for primary', primaryIdForLog);
  }
  return null;
}

/**
 * Найти recordId клона-ужина по основному (у клона в поле ссылки — основной).
 * @param {string} primaryEmployeeRecordId
 * @param {string} [primaryOrgLookupValue] — значение поля организации у основного (как в employee_info); для запасного обхода по сотрудникам org.
 */
async function findDinnerCloneEmployeeId(primaryEmployeeRecordId, primaryOrgLookupValue) {
  const pid = String(primaryEmployeeRecordId || '').trim();
  if (!pid) return null;
  const lf = F.EMP_DINNER_PRIMARY_LINK;
  const esc = escapeSingleQuotes(pid);

  const formulaAttempts = [
    `{${lf}} = '${esc}'`,
    `FIND('${esc}', ARRAYJOIN({${lf}}, ',')) > 0`,
    `SEARCH('${esc}', ARRAYJOIN({${lf}}, ',')) > 0`,
    `FIND('${esc}', ARRAYJOIN({${lf}}, '')) > 0`,
  ];

  const fieldsFetch = [F.EMP_ORG_LOOKUP, F.EMP_STATUS, lf];

  for (const formula of formulaAttempts) {
    try {
      const r = await atGet(TABLE.EMPLOYEES, {
        filterByFormula: formula,
        maxRecords: 10,
        'fields[]': fieldsFetch,
      });
      const raw = r.records || [];
      const linked = cloneRecordsLinkedToPrimary(raw, lf, pid);
      if (!linked.length) continue;
      const picked = pickSingleActiveClone(linked, pid);
      if (picked) return picked;
    } catch (e) {
      console.warn('[dinner_clone] formula attempt failed:', e?.message || e);
    }
  }

  const orgVal = primaryOrgLookupValue != null ? String(primaryOrgLookupValue).trim() : '';
  if (!orgVal) return null;

  try {
    const orgEsc = escapeSingleQuotes(orgVal);
    const orgF = F.EMP_ORG_LOOKUP;
    const allInOrg = await listAll(TABLE.EMPLOYEES, {
      filterByFormula: `{${orgF}} = '${orgEsc}'`,
      'fields[]': fieldsFetch,
    });
    const linked = cloneRecordsLinkedToPrimary(allInOrg, lf, pid);
    return pickSingleActiveClone(linked, pid);
  } catch (e) {
    console.warn('[dinner_clone] org scan fallback failed:', e?.message || e);
    return null;
  }
}

/**
 * Проверка: cloneId — это активный клон-ужин, привязанный к primaryId (та же организация).
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
async function verifyDinnerCloneBelongsToPrimary(cloneId, primaryId) {
  const cid = String(cloneId || '').trim();
  const pid = String(primaryId || '').trim();
  if (!cid || !pid) return { ok: false, error: 'dinner clone or primary missing' };

  const [cloneResp, primaryResp] = await Promise.all([
    atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${escapeSingleQuotes(cid)}'`,
      maxRecords: 1,
      'fields[]': [F.EMP_DINNER_PRIMARY_LINK, F.EMP_ORG_LOOKUP, F.EMP_STATUS],
    }),
    atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${escapeSingleQuotes(pid)}'`,
      maxRecords: 1,
      'fields[]': [F.EMP_ORG_LOOKUP],
    }),
  ]);

  const cloneRec = one(cloneResp.records);
  const primaryRec = one(primaryResp.records);
  if (!cloneRec) return { ok: false, error: 'dinner clone not found' };
  if (!primaryRec) return { ok: false, error: 'primary employee not found' };

  const links = linkFieldArray(cloneRec.fields?.[F.EMP_DINNER_PRIMARY_LINK]);
  if (!links.includes(pid)) return { ok: false, error: 'dinner employee mismatch' };

  const cOrg = Array.isArray(cloneRec.fields?.[F.EMP_ORG_LOOKUP])
    ? cloneRec.fields[F.EMP_ORG_LOOKUP][0]
    : cloneRec.fields?.[F.EMP_ORG_LOOKUP];
  const pOrg = Array.isArray(primaryRec.fields?.[F.EMP_ORG_LOOKUP])
    ? primaryRec.fields[F.EMP_ORG_LOOKUP][0]
    : primaryRec.fields?.[F.EMP_ORG_LOOKUP];
  if (String(cOrg || '') !== String(pOrg || '')) return { ok: false, error: 'dinner clone org mismatch' };

  const st = cloneRec.fields?.[F.EMP_STATUS];
  if (st && String(st).toLowerCase() !== 'active') return { ok: false, error: 'dinner clone not active' };

  return { ok: true };
}

module.exports = {
  findDinnerCloneEmployeeId,
  verifyDinnerCloneBelongsToPrimary,
};
