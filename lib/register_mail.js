/**
 * Общая рассылка письма «персональная ссылка на заказ» (как после /api/register).
 * Используется register.js и register_broadcast_org.js.
 */
const { TABLE, F } = require('./utils');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_REPLY_TO = (process.env.MAIL_REPLY_TO || '').trim();
const APP_ORIGIN = (process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || '').trim();
const BRAND_NAME = (process.env.BRAND_NAME || '[БАЗА] Корпоративное питание 2.0').trim();
const MAIL_LOGO_URL = (process.env.MAIL_LOGO_URL || '').trim();
const MAIL_SUBJECT_REGISTER =
  process.env.MAIL_SUBJECT_REGISTER || 'Персональная ссылка для заказа обедов';
const BRAND_ACCENT = (process.env.MAIL_BRAND_ACCENT || '#FFD12A').trim();
const BRAND_HEADER_BG = (process.env.MAIL_BRAND_HEADER_BG || '#171717').trim();
const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || '').trim();

const FLD_EMP_FIRST_NAME =
  process.env.FLD_EMP_FIRST_NAME || 'First Name';
const FLD_EMP_LAST_NAME =
  process.env.FLD_EMP_LAST_NAME || 'Last Name';
const FLD_EMP_PERSONAL_ORDER_LINK =
  process.env.FLD_EMP_PERSONAL_ORDER_LINK || 'PersonalOrderLink';

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

/** Фолбэк-ссылка, если формулы PersonalOrderLink ещё нет. */
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

async function fetchEmployeeLinkAndNames(atGet, employeeId) {
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
  const frec = rec.fields || {};
  const personalLink = String(frec[FLD_EMP_PERSONAL_ORDER_LINK] || '').trim();
  return {
    personalLink: isHttpUrl(personalLink) ? personalLink : '',
    firstName: String(frec[FLD_EMP_FIRST_NAME] || '').trim(),
    lastName: String(frec[FLD_EMP_LAST_NAME] || '').trim(),
  };
}

async function sendRegistrationEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY || !MAIL_FROM) {
    return { ok: false, skipped: true, reason: 'mail_not_configured' };
  }
  const fromResolved = resolveMailFrom();
  if (!fromResolved) return { ok: false, skipped: true, reason: 'mail_from_invalid' };
  const payload = {
    from: fromResolved,
    to: [to],
    subject: subject || MAIL_SUBJECT_REGISTER,
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

module.exports = {
  MAIL_SUBJECT_REGISTER,
  buildLink,
  buildRegistrationEmail,
  fetchEmployeeLinkAndNames,
  sendRegistrationEmail,
};
