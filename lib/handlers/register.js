// /lib/handlers/register.js
const { json, withRateLimit, atGet, atPost, atPatch, one, TABLE, F } = require('../utils');

function env(k, d){ return process.env[k] ?? d; }
const APP_ORIGIN = env('APP_ORIGIN', 'http://localhost:3000');

// — ищем организацию по коду org120
async function getOrgByCode(orgCode){
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${orgCode}'`,
    maxRecords: 1,
    "fields[]": [F.ORG_ID]
  });
  return one(r.records) || null;
}

function makeLink({ employeeId, org, token, hrBack }){
  const u = new URL('/order', APP_ORIGIN);
  u.searchParams.set('employeeID', employeeId);
  u.searchParams.set('org', org);
  u.searchParams.set('token', token);
  if (hrBack) u.searchParams.set('hrBack', '1');
  return u.toString();
}

// пробуем дописать имя/фамилию в разные возможные поля (если их нет — тихо игнорируем)
async function tryPatchNames(employeeId, { firstName, lastName }){
  const candidates = [
    { "First Name": firstName },
      ].filter(x => firstName && firstName.trim());

  const candidates2 = [
    { "Last Name": lastName },
  ].filter(x => lastName && lastName.trim());

  // Патчим по одной колонке за раз, игнорируя UNKNOWN_FIELD_NAME/INVALID_VALUE_FOR_COLUMN
  for (const fields of [...candidates, ...candidates2]) {
    try {
      await atPatch(TABLE.EMPLOYEES, { typecast: true, records: [{ id: employeeId, fields }] });
    } catch(e) {
      // 422 из-за неизвестного поля или computed — игнорируем
      // console.warn('name patch skipped', fields, e.message);
    }
  }
}

module.exports = withRateLimit(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method !== 'POST')   return json(res, 405, { error: 'POST only' });

  const body = await (async()=> {
    if (req.body && typeof req.body === 'object') return req.body;
    return await new Promise(r=>{
      let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{ r(JSON.parse(d||'{}')); }catch{ r({}); }});
    });
  })();

  const org     = (body.org||'').trim();
  const email   = (body.email||'').trim().toLowerCase();
  const first   = (body.firstName||'').trim();
  const last    = (body.lastName||'').trim();
  const hrBack  = !!body.hrBack;   // если регистрируем из HR-формы и хотим в письме ссылку с возвратом в консоль

  if (!org || !email) return json(res, 400, { ok:false, error:'org and email required' });

  // 1) организация существует?
  const orgRec = await getOrgByCode(org);
  if (!orgRec) return json(res, 404, { ok:false, error:'organization not found' });

  // 2) ищем сотрудника по email в этой org
  const filter = `
AND(
  LOWER({Email})='${email.replace(/'/g,"\\'")}',
  FIND('${org}', {${F.EMP_ORG_LOOKUP}}&'')>0
)`;
  const found = await atGet(TABLE.EMPLOYEES, {
    filterByFormula: filter,
    maxRecords: 1,
    "fields[]": [F.EMP_TOKEN]
  });
  let emp = one(found.records);

  // 3) если нет — создаём (НЕ пишем в FullName, это formula)
  if (!emp) {
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const create = await atPost(TABLE.EMPLOYEES, {
      typecast: true,
      records: [{
        fields: {
          Email: email,
          [F.EMP_TOKEN]: token,
          Status: 'Active',
          // ссылка на Organization через link:
          'Organization': [orgRec.id]    // если у вас иначе называется link-поле, поправьте название здесь
        }
      }]
    });
    emp = one(create.records);
    // Попробуем дозаписать имя/фамилию (в разные возможные поля). Ошибки игнорируем.
    await tryPatchNames(emp.id, { firstName: first, lastName: last });
  } else {
    // Убедимся, что токен есть
    const tok = emp.fields?.[F.EMP_TOKEN];
    if (!tok) {
      const newTok = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await atPatch(TABLE.EMPLOYEES, { typecast:true, records:[{ id:emp.id, fields:{ [F.EMP_TOKEN]: newTok } }] });
      emp.fields[F.EMP_TOKEN] = newTok;
    }
    // Обновим имя/фамилию (опционально)
    await tryPatchNames(emp.id, { firstName: first, lastName: last });
  }

  const link = makeLink({ employeeId: emp.id, org, token: emp.fields[F.EMP_TOKEN], hrBack });

  // Отправку письма можно держать опциональной. Если RESEND_* не настроен — вернём ссылку в ответе.
  let sent = false;
  try {
    const RESEND = process.env.RESEND_API_KEY;
    const MAIL_FROM = process.env.MAIL_FROM || 'no-reply@example.com';
    if (RESEND) {
      // minimalist plain mail via Resend
      const rsp = await fetch('https://api.resend.com/emails', {
        method:'POST',
        headers:{ 'Authorization':`Bearer ${RESEND}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: [email],
          subject: 'Ваш доступ к заказу обедов',
          text: `Здравствуйте!\n\nВаша персональная ссылка: ${link}\n\nСохраните её и переходите для выбора блюд.`
        })
      });
      sent = rsp.ok;
    }
  } catch(_) { /* без паники: если не отправилось — вернём ссылку в ответе */ }

  return json(res, 200, { ok:true, employeeId: emp.id, sent, link });
}, { windowMs: 4000, max: 15 });
