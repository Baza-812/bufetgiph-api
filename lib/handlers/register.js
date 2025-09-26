// /lib/handlers/register.js
const { json, atGet, atPost, atPatch, TABLE, F } = require('../../lib/utils');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM      = process.env.MAIL_FROM      || '';
const APP_ORIGIN     = process.env.APP_ORIGIN     || ''; // напр. https://bufetgiph.ru

// === ИМЕНА ПОЛЕЙ В AIRTABLE (можно переопределить через ENV) ===
const FLD_EMP_EMAIL      = process.env.FLD_EMP_EMAIL      || 'Email';        // текстовое поле e-mail
const FLD_EMP_ORG_LINK   = process.env.FLD_EMP_ORG_LINK   || 'Organization'; // link на таблицу Organizations
const FLD_EMP_FIRST_NAME = process.env.FLD_EMP_FIRST_NAME || 'First Name';   // текст
const FLD_EMP_LAST_NAME  = process.env.FLD_EMP_LAST_NAME  || 'Last Name';    // текст

// формируем персональную ссылку
function buildLink(origin, { employeeID, org, token }) {
  const base = origin || APP_ORIGIN;
  const u = new URL('/order', base || 'http://localhost:3000');
  u.searchParams.set('employeeID', employeeID);
  u.searchParams.set('org', org);
  u.searchParams.set('token', token);
  return u.toString();
}

// найти Организацию по коду (OrgID)
async function getOrgByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${orgCode}'`,
    maxRecords: 1,
    "fields[]": [F.ORG_ID, 'Name'] // Name забираем для возможных проверок
  });
  return (r.records && r.records[0]) || null;
}

// отправка письма через Resend
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !MAIL_FROM) return { ok:false, skipped:true, reason:'mail_not_configured' };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`mail_send_failed: ${resp.status} ${t}`);
  }
  return { ok:true };
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

    // 1) Организация
    const orgRec = await getOrgByCode(org);
    if (!orgRec) return json(res, 404, { error:'organization not found' });

    const fullName = `${lastName.trim()} ${firstName.trim()}`.trim();

    // 2) Пытаемся найти существующего сотрудника:
    //    фильтруем по link-полю Organization (а не по lookup), плюс совпадение ФИО и e-mail
    const filter = `AND(
      FIND('${orgRec.id}', ARRAYJOIN({${FLD_EMP_ORG_LINK}}&""))>0,
      {${F.EMP_NAME}}='${fullName}',
      LOWER({${FLD_EMP_EMAIL}})=LOWER('${email.trim()}')
    )`;

    const existed = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: filter,
      maxRecords: 1,
      "fields[]": [F.EMP_NAME, F.EMP_TOKEN, FLD_EMP_EMAIL, FLD_EMP_FIRST_NAME, FLD_EMP_LAST_NAME]
    });
    const rec = existed.records?.[0] || null;

    let employeeID, token;

    if (rec) {
      // ——— есть запись: выдаём ссылку, при необходимости дозаполняем токен/имя/фамилию
      employeeID = rec.id;
      token = rec.fields?.[F.EMP_TOKEN];
      const patch = {};
      if (!token || String(token).trim() === '') patch[F.EMP_TOKEN] = cryptoRandom();
      if (!rec.fields?.[FLD_EMP_FIRST_NAME])   patch[FLD_EMP_FIRST_NAME] = firstName.trim();
      if (!rec.fields?.[FLD_EMP_LAST_NAME])    patch[FLD_EMP_LAST_NAME]  = lastName.trim();
      if (Object.keys(patch).length) {
        await atPatch(TABLE.EMPLOYEES, { typecast: true, records: [{ id: employeeID, fields: patch }] });
        token = patch[F.EMP_TOKEN] || token;
      }
    } else {
      // ——— создаём нового
      token = cryptoRandom();
      const create = await atPost(TABLE.EMPLOYEES, {
        typecast: true,
        records: [{
          fields: {
            [FLD_EMP_ORG_LINK]: [orgRec.id],  // ВАЖНО: именно id записи организации в link-поле
            [F.EMP_ROLE]: 'Employee',
            [FLD_EMP_EMAIL]: email.trim(),
            [F.EMP_TOKEN]: token,
            [FLD_EMP_FIRST_NAME]: firstName.trim(),
            [FLD_EMP_LAST_NAME]:  lastName.trim(),
            // FullName (F.EMP_NAME) — формула, её НЕ заполняем
          }
        }]
      });
      employeeID = create.records?.[0]?.id;
      if (!employeeID) return json(res, 500, { error:'failed to create employee' });
    }

    // 3) Письмо со ссылкой
    const origin = getOrigin(req);
    const link = buildLink(origin, { employeeID, org, token });
    const subj = 'Персональная ссылка для заказа обедов';
    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5">
        <p>Здравствуйте, ${firstName} ${lastName}!</p>
        <p>Ваша персональная ссылка для заказа обедов:</p>
        <p><a href="${link}" target="_blank" style="color:#111; background:#FFD12A; text-decoration:none; padding:10px 14px; border-radius:10px; display:inline-block;">Перейти к заказу</a></p>
        <p style="color:#666;">Сохраните это письмо — ссылка постоянная.</p>
      </div>
    `;
    await sendEmail({ to: email.trim(), subject: subj, html });

    return json(res, 200, { ok:true, sent:true, email: email.trim() });
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
