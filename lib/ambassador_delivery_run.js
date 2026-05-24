// Чтение/запись строк лога AmbassadorDeliveryRuns (идемпотентность cron).
const { atGet, atPost, atPatch, one, TABLE, F } = require('./utils');

function esc(s) {
  return String(s || '').replace(/'/g, "\\'");
}

function logTable() {
  return (TABLE.AMBASSADOR_DELIVERY_RUNS || '').trim();
}

function isLogEnabled() {
  return Boolean(logTable());
}

async function findDeliveryRun(orgCode, deliveryDateISO) {
  const tbl = logTable();
  if (!tbl) return null;
  const f = `AND({${F.ADR_ORG_CODE}}='${esc(orgCode)}', {${F.ADR_DELIVERY_DATE}}='${esc(deliveryDateISO)}')`;
  const r = await atGet(tbl, {
    filterByFormula: f,
    maxRecords: 1,
    'fields[]': [F.ADR_WARN_SENT, F.ADR_CUTOFF_DONE, F.ADR_RESULT],
  });
  return one(r.records);
}

async function ensureDeliveryRun(orgCode, deliveryDateISO) {
  const tbl = logTable();
  if (!tbl) return null;
  const existing = await findDeliveryRun(orgCode, deliveryDateISO);
  if (existing) return existing;
  const created = await atPost(tbl, {
    typecast: true,
    records: [
      {
        fields: {
          [F.ADR_ORG_CODE]: String(orgCode).trim(),
          [F.ADR_DELIVERY_DATE]: String(deliveryDateISO).trim(),
          [F.ADR_WARN_SENT]: false,
          [F.ADR_CUTOFF_DONE]: false,
          [F.ADR_RESULT]: '',
        },
      },
    ],
  });
  return one(created.records);
}

async function patchDeliveryRun(recordId, fields) {
  const tbl = logTable();
  if (!tbl || !recordId) return { ok: false };
  await atPatch(tbl, { typecast: true, records: [{ id: recordId, fields }] });
  return { ok: true };
}

module.exports = {
  isLogEnabled,
  findDeliveryRun,
  ensureDeliveryRun,
  patchDeliveryRun,
};
