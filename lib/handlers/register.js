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
//   FLD_EMP_CONSENT_GIVEN — чекбокс согласия (по умолчанию ConsentGiven)
//   FLD_EMP_CONSENT_IP — IP при регистрации (по умолчанию ConsentIP)
//
const { json, atGet, atPost, atPatch, atDelete, listAll, TABLE, F } = require('../../lib/utils');

const {
  MAIL_SUBJECT_REGISTER,
  buildLink,
  buildRegistrationEmail,
  fetchEmployeeLinkAndNames,
  sendRegistrationEmail,
} = require('../register_mail');

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
const FLD_EMP_CONSENT_GIVEN = (process.env.FLD_EMP_CONSENT_GIVEN || 'ConsentGiven').trim();
const FLD_EMP_CONSENT_IP = (process.env.FLD_EMP_CONSENT_IP || 'ConsentIP').trim();

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

// найти Организацию по коду (OrgID)
async function getOrgByCode(orgCode) {
  const r = await atGet(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_ID}}='${orgCode}'`,
    maxRecords: 1,
    "fields[]": [F.ORG_ID, 'Name', F.ORG_CONTRACT_TYPE]
  });
  return (r.records && r.records[0]) || null;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok:true });
    if (req.method !== 'POST')   return json(res, 405, { error:'POST only' });

    const body = await readBody(req);
    const { org, firstName, lastName, email, consent } = body || {};
    if (!org || !firstName || !lastName || !email) {
      return json(res, 400, { error:'org, firstName, lastName, email required' });
    }
    if (consent !== true) {
      return json(res, 400, { error: 'consent required' });
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

    await recordConsentMeta(employeeID, getClientIp(req));

    if (didCreate && keeper1.id !== rowBeforeReconcile) {
      try {
        await atDelete(TABLE.EMPLOYEES, [rowBeforeReconcile]);
      } catch (e) {
        console.error('[register] atDelete duplicate employee row:', e?.message || e);
      }
    }

    // 2b) Подтянуть формульное поле ссылки и актуальные имена (после записи в Airtable)
    const fresh = await fetchEmployeeLinkAndNames(atGet, employeeID);
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
      mailMeta = await sendRegistrationEmail({
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

/** IP клиента (доверяем X-Forwarded-For на edge, иначе socket). */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first.slice(0, 255);
  }
  const ra = req.socket?.remoteAddress || '';
  return String(ra).replace(/^::ffff:/, '').slice(0, 255);
}

async function recordConsentMeta(employeeId, clientIp) {
  const fields = {};
  if (FLD_EMP_CONSENT_GIVEN) fields[FLD_EMP_CONSENT_GIVEN] = true;
  if (FLD_EMP_CONSENT_IP) fields[FLD_EMP_CONSENT_IP] = String(clientIp || '').slice(0, 255);
  if (Object.keys(fields).length === 0) return;
  try {
    await atPatch(TABLE.EMPLOYEES, { typecast: true, records: [{ id: employeeId, fields }] });
  } catch (e) {
    console.error('[register] consent fields:', e?.message || e);
  }
}

function getOrigin(req) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
    return `${proto}://${host}`;
  } catch { return ''; }
}
