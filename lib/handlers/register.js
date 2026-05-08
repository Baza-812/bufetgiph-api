// /lib/handlers/register.js
// Письмо с персональной ссылкой — Resend (отключите автоматизацию «email при новой записи» в Airtable).
//
// ENV (проект API, например Vercel):
//   RESEND_API_KEY     — секрет Resend
//   MAIL_FROM          — email (reg@baza.menu) ИЛИ уже полная строка «Имя <email@domain>»
//   MAIL_FROM_NAME     — если MAIL_FROM только email, подставляется как отображаемое имя (по умолчанию = BRAND_NAME)
//   APP_ORIGIN         — запасной базовый URL, если в Airtable ещё нет PersonalOrderLink (формула)
//   MAIL_REPLY_TO      — опционально
//   BRAND_NAME         — опционально, по умолчанию «Корпоративное питание»
//   MAIL_LOGO_URL      — опционально, абсолютный URL логотипа в шапке письма
//   MAIL_SUBJECT_REGISTER — опционально, тема письма
//   FLD_EMP_PERSONAL_ORDER_LINK — опционально, имя поля со ссылкой (по умолчанию PersonalOrderLink)
//   FLD_EMP_CREATED — опционально, поле даты создания (если нет createdTime в ответе API)
//   FLD_EMP_DEDUPE_KEY_FIELD — поле ключа дубля как в автоматизации (по умолчанию EmailKey). Пусто или «off» — не запрашивать, только org+email.
//
const { json, atGet, atPost, atPatch, atDelete, listAll, TABLE, F } = require('../../lib/utils');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_REPLY_TO = (process.env.MAIL_REPLY_TO || '').trim();
const APP_ORIGIN = (process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || '').trim();
const BRAND_NAME = (process.env.BRAND_NAME || '[БАЗА] Корпоративное питание 2.0').trim();
const MAIL_LOGO_URL = (process.env.MAIL_LOGO_URL || '').trim();
const MAIL_SUBJECT_REGISTER = (process.env.MAIL_SUBJECT_REGISTER || 'Персональная ссылка для заказа обедов').trim();
const BRAND_ACCENT = (process.env.MAIL_BRAND_ACCENT || '#FFD12A').trim();
const BRAND_HEADER_BG = (process.env.MAIL_BRAND_HEADER_BG || '#171717').trim();
const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || '').trim();

// === ИМЕНА ПОЛЕЙ В AIRTABLE (можно переопределить через ENV) ===
const FLD_EMP_EMAIL      = process.env.FLD_EMP_EMAIL      || 'Email';        // текстовое поле e-mail
const FLD_EMP_ORG_LINK   = process.env.FLD_EMP_ORG_LINK   || 'Organization'; // link на таблицу Organizations
const FLD_EMP_FIRST_NAME = process.env.FLD_EMP_FIRST_NAME || 'First Name';   // текст
const FLD_EMP_LAST_NAME  = process.env.FLD_EMP_LAST_NAME  || 'Last Name';    // текст
const FLD_EMP_PERSONAL_ORDER_LINK =
  process.env.FLD_EMP_PERSONAL_ORDER_LINK || 'PersonalOrderLink'; // формула URL
const FLD_EMP_CREATED = process.env.FLD_EMP_CREATED || 'CreatedAt'; // запасной критерий «раньше всех»
const _dedupeKeyRaw = process.env.FLD_EMP_DEDUPE_KEY_FIELD;
const FLD_EMP_DEDUPE_KEY_FIELD =
  _dedupeKeyRaw === '' || String(_dedupeKeyRaw || '').toLowerCase() === 'off'
    ? ''
    : (_dedupeKeyRaw || process.env.FLD_EMP_EMAIL_KEY || 'EmailKey');

function escapeAirtableSingleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function recordCreatedMs(rec) {
  if (rec.createdTime) return new Date(rec.createdTime).getTime();
  const v = rec.fields?.[FLD_EMP_CREATED];
  if (v) return new Date(v).getTime();
  return Number.MAX_SAFE_INTEGER;
}

function sortByCreated(recs) {
  const arr = [...(recs || [])];
  arr.sort((a, b) => recordCreatedMs(a) - recordCreatedMs(b));
  return arr;
}

/** Все кандидаты-дубли: тот же email и (ссылка на org ИЛИ lookup OrgID как у формы). Полный обход пагинации. */
async function listDuplicatesBroad(orgRec, orgCode, emailLower) {
  const emailInFormula = escapeAirtableSingleQuoted(emailLower);
  const orgCodeEsc = escapeAirtableSingleQuoted(String(orgCode || '').trim());
  const dupFilter = `AND(
    LOWER({${FLD_EMP_EMAIL}})=LOWER('${emailInFormula}'),
    OR(
      FIND('${orgRec.id}', ARRAYJOIN({${FLD_EMP_ORG_LINK}}&""))>0,
      FIND('${orgCodeEsc}', ARRAYJOIN({${F.EMP_ORG_LOOKUP}}&""))>0
    )
  )`;
  const fields = [
    F.EMP_TOKEN,
    FLD_EMP_EMAIL,
    FLD_EMP_FIRST_NAME,
    FLD_EMP_LAST_NAME,
    FLD_EMP_CREATED,
  ];
  if (FLD_EMP_DEDUPE_KEY_FIELD) fields.push(FLD_EMP_DEDUPE_KEY_FIELD);
  return listAll(TABLE.EMPLOYEES, { filterByFormula: dupFilter, 'fields[]': fields });
}

/**
 * Как автоматизация Airtable: сначала по EmailKey с текущей строки, иначе широкий список.
 */
async function listDuplicatesPreferEmailKey(employeeId, orgRec, orgCode, emailLower) {
  const fields = [
    F.EMP_TOKEN,
    FLD_EMP_EMAIL,
    FLD_EMP_FIRST_NAME,
    FLD_EMP_LAST_NAME,
    FLD_EMP_CREATED,
  ];
  if (FLD_EMP_DEDUPE_KEY_FIELD) fields.push(FLD_EMP_DEDUPE_KEY_FIELD);

  const curResp = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${employeeId}'`,
    maxRecords: 1,
    'fields[]': fields,
  });
  const rec = curResp.records?.[0];
  if (!rec) return listDuplicatesBroad(orgRec, orgCode, emailLower);

  const keyRaw = FLD_EMP_DEDUPE_KEY_FIELD ? rec.fields?.[FLD_EMP_DEDUPE_KEY_FIELD] : null;
  const keyStr = keyRaw != null ? String(keyRaw).trim() : '';

  if (keyStr && FLD_EMP_DEDUPE_KEY_FIELD) {
    const keyEsc = escapeAirtableSingleQuoted(keyStr);
    const byKey = await listAll(TABLE.EMPLOYEES, {
      filterByFormula: `{${FLD_EMP_DEDUPE_KEY_FIELD}}='${keyEsc}'`,
      'fields[]': fields,
    });
    if (byKey.length > 0) return byKey;
  }

  return listDuplicatesBroad(orgRec, orgCode, emailLower);
}

async function ensureKeeperTokenAndNames(keeperId, fieldsSnapshot, fnNorm, lnNorm) {
  const patch = {};
  let tok = fieldsSnapshot[F.EMP_TOKEN];
  if (!tok || String(tok).trim() === '') patch[F.EMP_TOKEN] = cryptoRandom();
  if (!fieldsSnapshot[FLD_EMP_FIRST_NAME]) patch[FLD_EMP_FIRST_NAME] = fnNorm;
  if (!fieldsSnapshot[FLD_EMP_LAST_NAME]) patch[FLD_EMP_LAST_NAME] = lnNorm;
  if (Object.keys(patch).length) {
    await atPatch(TABLE.EMPLOYEES, { typecast: true, records: [{ id: keeperId, fields: patch }] });
    tok = patch[F.EMP_TOKEN] || tok;
  }
  return tok;
}

function formatPersonNamePart(s) {
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

function resolveMailFrom() {
  const raw = MAIL_FROM.trim();
  if (!raw) return '';
  if (/<[^>]+@[^>]+>/.test(raw)) return raw;
  const display = (MAIL_FROM_NAME || BRAND_NAME).trim() || 'Baza';
  return `${display} <${raw}>`;
}

function isHttpUrl(s) {
  const t = String(s || '').trim();
  return /^https?:\/\//i.test(t);
}

async function fetchEmployeeLinkAndNames(employeeId) {
  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `RECORD_ID()='${employeeId}'`,
    maxRecords: 1,
    'fields[]': [
      FLD_EMP_FIRST_NAME,
      FLD_EMP_LAST_NAME,
      FLD_EMP_PERSONAL_ORDER_LINK,
    ],
  });
  const rec = r.records?.[0];
  if (!rec) return { personalLink: '', firstName: '', lastName: '' };
  const f = rec.fields || {};
  const personalLink = String(f[FLD_EMP_PERSONAL_ORDER_LINK] || '').trim();
  return {
    personalLink: isHttpUrl(personalLink) ? personalLink : '',
    firstName: String(f[FLD_EMP_FIRST_NAME] || '').trim(),
    lastName: String(f[FLD_EMP_LAST_NAME] || '').trim(),
  };
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// формируем персональную ссылку
function buildLink(origin, { employeeID, org, token }) {
  const baseRaw = (APP_ORIGIN || origin || 'http://localhost:3000').trim();
  const base = baseRaw.replace(/\/+$/, '');
  const u = new URL('/order', `${base}/`);
  u.searchParams.set('employeeID', employeeID);
  u.searchParams.set('org', org);
  u.searchParams.set('token', token);
  return u.toString();
}

function buildRegistrationEmail({ firstName, lastName, link, orgName }) {
  const fn = escHtml(firstName);
  const ln = escHtml(lastName);
  const orgLine = orgName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#3f3f46;">Организация: <strong>${escHtml(orgName)}</strong></p>`
    : '';
  const logoBlock = MAIL_LOGO_URL
    ? `<img src="${escHtml(MAIL_LOGO_URL)}" alt="" width="160" style="max-width:160px;height:auto;display:block;margin:0 auto 12px;border:0;" />`
    : '';

  const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:${escHtml(BRAND_HEADER_BG)};padding:28px 24px;text-align:center;">
              ${logoBlock}
              <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:18px;font-weight:700;color:#fafafa;letter-spacing:0.02em;">${escHtml(BRAND_NAME)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#18181b;">
              <p style="margin:0 0 12px;">Здравствуйте, ${fn} ${ln}!</p>
              ${orgLine}
              <p style="margin:0 0 20px;">Ниже — ваша персональная ссылка для заказа обедов. Сохраните это письмо: ссылка постоянная.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px;">
                <tr>
                  <td style="border-radius:10px;background:${escHtml(BRAND_ACCENT)};">
                    <a href="${escHtml(link)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;font-weight:600;color:#18181b;text-decoration:none;">Перейти к заказу</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:13px;line-height:1.5;color:#71717a;">Если кнопка не открывается, скопируйте ссылку в браузер:<br/><span style="word-break:break-all;color:#3f3f46;">${escHtml(link)}</span></p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:12px;line-height:1.45;color:#a1a1aa;border-top:1px solid #f4f4f5;">
              Это письмо отправлено автоматически при регистрации. Отвечать на него не нужно.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Здравствуйте, ${firstName} ${lastName}!`,
    orgName ? `Организация: ${orgName}` : '',
    '',
    'Ваша персональная ссылка для заказа обедов (сохраните — ссылка постоянная):',
    link,
    '',
    `— ${BRAND_NAME}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { html, text };
}

// найти Организацию по коду (OrgID)
async function getOrgByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${orgCode}'`,
    maxRecords: 1,
    "fields[]": [F.ORG_ID, 'Name', F.ORG_CONTRACT_TYPE]
  });
  return (r.records && r.records[0]) || null;
}

// отправка письма через Resend
async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY || !MAIL_FROM) {
    return { ok: false, skipped: true, reason: 'mail_not_configured' };
  }
  const fromResolved = resolveMailFrom();
  if (!fromResolved) return { ok: false, skipped: true, reason: 'mail_from_invalid' };
  const payload = {
    from: fromResolved,
    to: [to],
    subject,
    html,
    text: text || undefined,
  };
  if (MAIL_REPLY_TO) payload.reply_to = MAIL_REPLY_TO;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return { ok: false, error: `mail_send_failed: ${resp.status} ${t}` };
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok:true });
    if (req.method !== 'POST')   return json(res, 405, { error:'POST only' });

    const body = await readBody(req);
    const { org, firstName, lastName, email } = body || {};
    if (!org || !firstName || !lastName || !email) {
      return json(res, 400, { error:'org, firstName, lastName, email required' });
    }

    const fnNorm = formatPersonNamePart(firstName);
    const lnNorm = formatPersonNamePart(lastName);

    // 1) Организация
    const orgRec = await getOrgByCode(org);
    if (!orgRec) return json(res, 404, { error:'organization not found' });

    const emailLower = email.trim().toLowerCase();

    // 2) Дубли: широкий поиск (ссылка Organization ИЛИ lookup OrgID) + все страницы listAll.
    const group0 = sortByCreated(await listDuplicatesBroad(orgRec, org, emailLower));
    const keeper0 = group0[0] || null;

    let employeeID;
    let token;
    let didCreate = false;

    if (keeper0) {
      employeeID = keeper0.id;
      token = keeper0.fields?.[F.EMP_TOKEN];
    } else {
      didCreate = true;
      const contractType = String(orgRec.fields?.[F.ORG_CONTRACT_TYPE] || '').trim();
      const initialRole = contractType === 'Ambassador' ? 'TeamMember' : 'Employee';
      token = cryptoRandom();
      const create = await atPost(TABLE.EMPLOYEES, {
        typecast: true,
        records: [{
          fields: {
            [FLD_EMP_ORG_LINK]: [orgRec.id],
            [F.EMP_ROLE]: initialRole,
            [FLD_EMP_EMAIL]: emailLower,
            [F.EMP_TOKEN]: token,
            [FLD_EMP_FIRST_NAME]: fnNorm,
            [FLD_EMP_LAST_NAME]: lnNorm,
          }
        }]
      });
      employeeID = create.records?.[0]?.id;
      if (!employeeID) return json(res, 500, { error:'failed to create employee' });
    }

    // 2a) Повторная выборка по EmailKey (как скрипт автоматизации) → канонический keeper; лишнюю строку удаляем.
    const group1 = sortByCreated(await listDuplicatesPreferEmailKey(employeeID, orgRec, org, emailLower));
    const keeper1 = group1[0];
    if (!keeper1) {
      return json(res, 500, { error: 'employee reconcile failed' });
    }

    const rowBeforeReconcile = employeeID;
    employeeID = keeper1.id;
    token = await ensureKeeperTokenAndNames(employeeID, keeper1.fields || {}, fnNorm, lnNorm);

    if (didCreate && keeper1.id !== rowBeforeReconcile) {
      try {
        await atDelete(TABLE.EMPLOYEES, [rowBeforeReconcile]);
      } catch (e) {
        console.error('[register] atDelete duplicate employee row:', e?.message || e);
      }
    }

    // 2b) Подтянуть формульное поле ссылки и актуальные имена (после записи в Airtable)
    const fresh = await fetchEmployeeLinkAndNames(employeeID);
    const origin = getOrigin(req);
    const linkFallback = buildLink(origin, { employeeID, org, token });
    const link = fresh.personalLink || linkFallback;

    const fnMail = formatPersonNamePart(fresh.firstName || fnNorm);
    const lnMail = formatPersonNamePart(fresh.lastName || lnNorm);

    // 3) Письмо со ссылкой (Resend; не полагаемся на автоматизации Airtable)
    const orgName = String(orgRec.fields?.Name || '').trim();
    const { html, text } = buildRegistrationEmail({
      firstName: fnMail,
      lastName: lnMail,
      link,
      orgName,
    });

    let emailSent = false;
    let mailMeta = null;
    try {
      mailMeta = await sendEmail({
        to: email.trim().toLowerCase(),
        subject: MAIL_SUBJECT_REGISTER,
        html,
        text,
      });
      emailSent = Boolean(mailMeta?.ok);
    } catch (err) {
      console.error('[register] sendEmail:', err?.message || err);
      mailMeta = { ok: false, error: err?.message || String(err) };
    }

    if (mailMeta?.skipped) {
      console.warn('[register] mail skipped:', mailMeta.reason);
    } else if (mailMeta && !mailMeta.ok) {
      console.error('[register] mail failed:', mailMeta.error);
    }

    return json(res, 200, {
      ok: true,
      emailSent,
      email: email.trim().toLowerCase(),
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
};

/* helpers */
function cryptoRandom() {
  return (global.crypto?.randomUUID?.() || require('crypto').randomBytes(16).toString('hex'));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise(res=>{
    let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{res(JSON.parse(d||'{}'));}catch{res({});} });
  });
}

function getOrigin(req) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
    return `${proto}://${host}`;
  } catch { return ''; }
}
