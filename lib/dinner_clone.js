// lib/dinner_clone.js — клон сотрудника «ужин»: ссылка на основного в Employees.
const { atGet, one, TABLE, F } = require('./utils');

function linkFieldArray(val) {
  if (Array.isArray(val)) return val.filter(Boolean);
  return val ? [val] : [];
}

function escapeSingleQuotes(s) {
  return String(s || '').replace(/'/g, "\\'");
}

/** Найти recordId клона-ужина по основному сотруднику (в клоне в поле ссылки — основной). */
async function findDinnerCloneEmployeeId(primaryEmployeeRecordId) {
  const pid = String(primaryEmployeeRecordId || '').trim();
  if (!pid) return null;
  const lf = F.EMP_DINNER_PRIMARY_LINK;
  const esc = escapeSingleQuotes(pid);
  const formula = `FIND('${esc}', ARRAYJOIN({${lf}}&''))>0`;
  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: formula,
    maxRecords: 1,
    'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_STATUS],
  });
  return r.records?.[0]?.id || null;
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
