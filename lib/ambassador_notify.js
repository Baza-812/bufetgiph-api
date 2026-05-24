// Resend + Telegram для cron Ambassador (минимум команды).
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || '').trim();
const MAIL_REPLY_TO = (process.env.MAIL_REPLY_TO || '').trim();
const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || '').trim();
const BRAND_NAME = (process.env.BRAND_NAME || '[БАЗА] Корпоративное питание 2.0').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

function resolveMailFrom() {
  if (!MAIL_FROM) return null;
  if (MAIL_FROM.includes('<')) return MAIL_FROM;
  const name = MAIL_FROM_NAME || BRAND_NAME;
  return `${name} <${MAIL_FROM}>`;
}

async function sendResendEmail({ to, subject, html, text }) {
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

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    return { ok: false, skipped: true, reason: 'telegram_not_configured' };
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId).trim(),
      text: String(text || '').slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return { ok: false, error: `telegram_failed: ${resp.status} ${t}` };
  }
  return { ok: true };
}

module.exports = { sendResendEmail, sendTelegramMessage };
