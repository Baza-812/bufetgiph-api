// lib/handlers/register.js
const { json, withRateLimit, atGet, atPost, atPatch, one, TABLE, F } = require('../utils');

function newToken(len = 22) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

async function getOrgByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${orgCode}'`,
    maxRecords: 1,
    "fields[]": [F.ORG_ID]
  });
  return one(r.records);
}

async function findEmployeeByEmailInOrg(email, orgId) {
  // Ищем по email, а принадлежность к орг. проверим в коде (link поле)
  const r = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: `LOWER({${F.EMP_EMAIL}})='${String(email).toLowerCase()}'`,
    pageSize: 50,
    "fields[]": [F.EMP_EMAIL, F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_NAME]
  });
  const recs = r.records || [];
  for (const rec of recs) {
    const orgLink = rec.fields?.[F.EMP_ORG_LOOKUP];
    const linkedOrg = Array.isArray(orgLink) ? orgLink[0] : orgLink;
    if (linkedOrg === orgId) return rec;
  }
  return null;
}

async function createEmployee({ orgRecId, firstName, lastName, email, token }) {
  const full = [lastName, firstName].filter(Boolean).join(' ').trim();
  const r = await atPost(TABLE.EMPLOYEES, {
    typecast: true,
    records: [{
      fields: {
        [F.EMP_NAME]: full || email,
        [F.EMP_EMAIL]: email,
        [F.EMP_TOKEN]: token,
        [F.EMP_STATUS]: 'Active',
        [F.EMP_ORG_LOOKUP]: [orgRecId]
      }
    }]
  });
  return one(r.records);
}

async function updateEmployeeToken(empId, token, fullName) {
  const fields = { [F.EMP_TOKEN]: token };
  if (fullName) fields[F.EMP_NAME] = fullName;
  const r = await atPatch(TABLE.EMPLOYEES, {
    typecast: true,
    records: [{ id: empId, fields }]
  });
  return one(r.records);
}

// Отправка письма через Resend (простой REST запрос).
// Установите в Vercel переменные окружения: RESEND_API_KEY, MAIL_FROM, SITE_ORIGIN
async function sendPersonalEmail({ to, from, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('Resend disabled. Email would be sent to:', to, 'subject:', subject);
    return { ok: true, mocked: true };
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, from, subject, html })
  });
  if (!r.ok) throw new Error(`Resend: ${r.status} ${await r.text()}`);
  return r.json();
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'POST')     return json(res, 405, { error: 'POST only' });

  try {
    const body = (await new Promise(resolve => {
      let d = ''; req.on('data', c => d += c);
      req.on('end', () => { try { resolve(JSON.parse(d||'{}')); } catch { resolve({}); } });
    })) || {};

    const { org, firstName, lastName, email } = body;

    if (!org || !email || !(firstName || lastName)) {
      return json(res, 400, { ok: false, error: 'org, email и фамилия/имя — обязательны' });
    }

    const orgRec = await getOrgByCode(org);
    if (!orgRec) return json(res, 404, { ok: false, error: 'organization not found' });

    // ищем сотрудника
    let emp = await findEmployeeByEmailInOrg(email, orgRec.id);

    // токен — старый (если есть) или новый
    const fullName = [lastName, firstName].filter(Boolean).join(' ').trim();
    let token;

    if (!emp) {
      token = newToken();
      emp = await createEmployee({
        orgRecId: orgRec.id,
        firstName, lastName, email, token
      });
    } else {
      token = emp.fields?.[F.EMP_TOKEN] || newToken();
      // обновим токен/ФИО
      await updateEmployeeToken(emp.id, token, fullName || emp.fields?.[F.EMP_NAME]);
    }

    if (!emp?.id) return json(res, 500, { ok: false, error: 'employee create/update failed' });

    const site = process.env.SITE_ORIGIN || `https://${req.headers.host}`;
    const personalUrl = `${site}/order?employeeID=${encodeURIComponent(emp.id)}&org=${encodeURIComponent(org)}&token=${encodeURIComponent(token)}`;

    // Отправляем письмо
    const from = process.env.MAIL_FROM || 'no-reply@yourdomain.com';
    const subject = 'Ваша персональная ссылка для заказа обедов';
    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif">
        <p>Здравствуйте${fullName ? ', ' + fullName : ''}!</p>
        <p>Вот ваша персональная ссылка для заказа обедов:</p>
        <p><a href="${personalUrl}" target="_blank" style="display:inline-block;padding:10px 16px;background:#facc15;color:#111;text-decoration:none;border-radius:10px">Перейти к заказу</a></p>
        <p><a href="${personalUrl}" target="_blank">${personalUrl}</a></p>
        <hr style="border:none;border-top:1px solid #eee"/>
        <p style="font-size:12px;color:#666">Если вы не ожидали это письмо — просто проигнорируйте его.</p>
      </div>
    `;
    try {
      await sendPersonalEmail({ to: email, from, subject, html });
    } catch (e) {
      // Письмо не критично для API-успеха — просто логируем
      console.error('email send failed:', e);
    }

    return json(res, 200, {
      ok: true,
      employeeID: emp.id,
      token,
      personalUrl
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || String(e) });
  }
}, { windowMs: 60000, max: 20 });
