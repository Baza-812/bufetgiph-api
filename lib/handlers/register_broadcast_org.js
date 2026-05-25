// POST /api/register_broadcast_org
// Отправить письма с персональной ссылкой всем активным сотрудникам организации (тот же шаблон, что /api/register).
//
// Авторизация (одно из двух):
//   1) HR: JSON { org, employeeID, token, dryRun? } — как в hr_orders: роль вызывающего должна содержать «HR», org/token совпадают.
//   2) Секрет: REGISTER_BROADCAST_KEY в env + в теле { org, broadcastKey } или заголовок x-register-broadcast-key.
//
// Опционально: REGISTER_BROADCAST_DELAY_MS между письмами (по умолчанию 400), ограничение ~ Resend rate.
//
// Если в теле передан targetEmployeeId (RECORD_ID сотрудника), письмо уходит только ему — при условии,
// что он в этой организации (как у остальных участников выборки).

const crypto = require('crypto');
const { json, atGet, atPatch, listAll, TABLE, F } = require('../utils');

const {
  MAIL_SUBJECT_REGISTER,
  buildLink,
  buildRegistrationEmail,
  fetchEmployeeLinkAndNames,
  sendRegistrationEmail,
} = require('../register_mail');

const FLD_EMP_FIRST_NAME =
  process.env.FLD_EMP_FIRST_NAME || 'First Name';
const FLD_EMP_LAST_NAME =
  process.env.FLD_EMP_LAST_NAME || 'Last Name';
const FLD_EMP_EMAIL_FIELD = F.EMP_EMAIL;

function getBroadcastSecret() {
  return String(process.env.REGISTER_BROADCAST_KEY || '').trim();
}

const DELAY_MS = Math.min(
  5000,
  Math.max(0, Number(process.env.REGISTER_BROADCAST_DELAY_MS || 400))
);

async function sleep(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return await new Promise((res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        res(d ? JSON.parse(d) : {});
      } catch {
        res({});
      }
    });
  });
}

function getOrigin(req) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host =
      req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    return `${proto}://${host}`;
  } catch {
    return '';
  }
}

function formatPersonPart(s) {
  const segment = (w) => {
    if (!w) return '';
    const lower = w.toLocaleLowerCase('ru-RU');
    return lower.charAt(0).toLocaleUpperCase('ru-RU') + lower.slice(1);
  };
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.split('-').map(segment).join('-'))
    .join(' ');
}

function isActiveEmployee(st) {
  if (st == null || String(st).trim() === '') return true;
  return String(st).trim().toLowerCase() === 'active';
}

function deriveNames(fields) {
  let fn = String(fields[FLD_EMP_FIRST_NAME] || '').trim();
  let ln = String(fields[FLD_EMP_LAST_NAME] || '').trim();
  if (!fn && !ln) {
    const full = String(fields[F.EMP_NAME] || '').trim();
    const parts = full.split(/\s+/).filter(Boolean);
    fn = parts[0] ? formatPersonPart(parts[0]) : '';
    ln = parts.slice(1).map(formatPersonPart).join(' ');
  }
  fn = fn || 'Коллега';
  return { fn, ln };
}

function randomToken() {
  return global.crypto?.randomUUID?.() || crypto.randomBytes(16).toString('hex');
}

async function ensureOrderToken(recordId, currentTok) {
  if (currentTok && String(currentTok).trim()) return String(currentTok).trim();
  const tok = randomToken();
  await atPatch(TABLE.EMPLOYEES, {
    typecast: true,
    records: [{ id: recordId, fields: { [F.EMP_TOKEN]: tok } }],
  });
  return tok;
}

async function verifyHrCaller(orgCode, empId, token) {
  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${String(empId).replace(/'/g, "\\'")}'`,
    maxRecords: 1,
    'fields[]': [
      F.EMP_ORG_LOOKUP,
      F.EMP_TOKEN,
      F.EMP_STATUS,
      F.EMP_ROLE,
    ],
  });
  const me = r.records?.[0];
  if (!me) return { ok: false, error: 'employee not found' };
  const f = me.fields || {};
  const meOrg = Array.isArray(f[F.EMP_ORG_LOOKUP])
    ? f[F.EMP_ORG_LOOKUP][0]
    : f[F.EMP_ORG_LOOKUP];
  if (String(meOrg || '') !== String(orgCode || '').trim()) {
    return { ok: false, error: 'org mismatch' };
  }
  if (f[F.EMP_TOKEN] !== token) return { ok: false, error: 'invalid token' };

  const roleNorm = String(f[F.EMP_ROLE] || '').toUpperCase();
  const isHr = roleNorm.includes('HR');
  if (!isHr) return { ok: false, error: 'HR role required' };

  const st = f[F.EMP_STATUS];
  if (
    st != null &&
    String(st).trim() !== '' &&
    String(st).trim().toLowerCase() !== 'active'
  ) {
    return { ok: false, error: 'employee not active' };
  }

  return { ok: true };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    const body = await readBody(req);
    const org = String(body?.org || '').trim();
    const dryRun = Boolean(body?.dryRun);

    if (!org) return json(res, 400, { error: 'org required' });

    const secretConfigured = Boolean(getBroadcastSecret());
    const headerKey = String(
      req.headers['x-register-broadcast-key'] || ''
    ).trim();
    const bodyKey = String(body?.broadcastKey || '').trim();
    const keyOk =
      secretConfigured &&
      getBroadcastSecret() &&
      (headerKey === getBroadcastSecret() ||
        bodyKey === getBroadcastSecret());

    let authorized = keyOk;

    if (!authorized) {
      const empId = String(body?.employeeID || '').trim();
      const tok = String(body?.token || '').trim();
      if (!empId || !tok) {
        return json(res, 401, {
          error:
            'Provide REGISTER_BROADCAST_KEY (header x-register-broadcast-key or body.broadcastKey), or HR credentials (employeeID + token)',
        });
      }
      const v = await verifyHrCaller(org, empId, tok);
      if (!v.ok) return json(res, 403, { error: v.error });
      authorized = true;
    }

    const orgEsc = String(org).replace(/'/g, "\\'");
    const orgResp = await atGet(TABLE.ORGS, {
      filterByFormula: `{${F.ORG_ID}}='${orgEsc}'`,
      maxRecords: 1,
      'fields[]': [F.ORG_ID, 'Name'],
    });
    const orgRec = orgResp.records?.[0];
    if (!orgRec) return json(res, 404, { error: 'organization not found' });
    const orgName = String(orgRec.fields?.Name || '').trim();

    const empFields = [
      FLD_EMP_EMAIL_FIELD,
      FLD_EMP_FIRST_NAME,
      FLD_EMP_LAST_NAME,
      F.EMP_NAME,
      F.EMP_TOKEN,
      F.EMP_STATUS,
      F.EMP_ROLE,
    ];

    let members = await listAll(TABLE.EMPLOYEES, {
      filterByFormula: `{${F.EMP_ORG_LOOKUP}}='${orgEsc}'`,
      'fields[]': empFields,
    });

    const targetEmployeeId = String(body?.targetEmployeeId || '').trim();
    if (targetEmployeeId) {
      members = members.filter((r) => r.id === targetEmployeeId);
      if (!members.length) {
        return json(res, 404, {
          error: 'employee not found in this organization',
        });
      }
    }

    const origin = getOrigin(req);
    const results = [];

    let sent = 0;
    let skipped = 0;

    for (let i = 0; i < members.length; i++) {
      const rec = members[i];
      const f = rec.fields || {};
      const email = String(f[FLD_EMP_EMAIL_FIELD] || '')
        .trim()
        .toLowerCase();

      if (!email) {
        skipped += 1;
        results.push({ id: rec.id, status: 'skipped', reason: 'no_email' });
        continue;
      }

      if (!isActiveEmployee(f[F.EMP_STATUS])) {
        skipped += 1;
        results.push({ id: rec.id, status: 'skipped', reason: 'not_active' });
        continue;
      }

      let token = f[F.EMP_TOKEN] && String(f[F.EMP_TOKEN]).trim();
      if (!token) {
        if (dryRun) {
          skipped += 1;
          results.push({
            id: rec.id,
            status: 'skipped',
            reason: 'no_order_token_dry_run',
          });
          continue;
        }
        token = await ensureOrderToken(rec.id, f[F.EMP_TOKEN]);
      }

      try {
        let personalFromAirtable = '';
        let freshFirst = '';
        let freshLast = '';
        if (!dryRun) {
          const fresh = await fetchEmployeeLinkAndNames(atGet, rec.id);
          personalFromAirtable = String(fresh.personalLink || '').trim();
          freshFirst = fresh.firstName || '';
          freshLast = fresh.lastName || '';
        }

        const linkFallback = buildLink(origin, {
          employeeID: rec.id,
          org,
          token,
        });
        const link = personalFromAirtable || linkFallback;

        const rawNames = deriveNames(f);
        const fnMail = freshFirst
          ? formatPersonPart(freshFirst)
          : formatPersonPart(rawNames.fn);
        const lnMail = freshLast
          ? formatPersonPart(freshLast)
          : formatPersonPart(rawNames.ln);

        const mail = buildRegistrationEmail({
          firstName: fnMail,
          lastName: lnMail,
          link,
          orgName,
        });

        if (dryRun) {
          results.push({
            id: rec.id,
            status: 'dry_run',
            email,
          });
          continue;
        }

        const mailMeta = await sendRegistrationEmail({
          to: email,
          subject: MAIL_SUBJECT_REGISTER,
          html: mail.html,
          text: mail.text,
        });

        if (mailMeta?.ok) {
          sent += 1;
          results.push({ id: rec.id, status: 'sent', email });
        } else {
          results.push({
            id: rec.id,
            status: 'error',
            email,
            error: mailMeta?.error || mailMeta?.reason || 'send_failed',
          });
        }
      } catch (e) {
        results.push({
          id: rec.id,
          status: 'error',
          email: email || null,
          error: e?.message || String(e),
        });
      }

      if (DELAY_MS > 0 && i < members.length - 1 && !dryRun) {
        await sleep(DELAY_MS);
      }
    }

    return json(res, 200, {
      ok: true,
      org,
      dryRun,
      total: members.length,
      sent,
      skipped,
      results,
    });
  } catch (e) {
    console.error('[register_broadcast_org]', e);
    return json(res, 500, { ok: false, error: e.message || String(e) });
  }
};
