// GET /api/ambassador_cutoff_cron?key=SECRET
// Каждые 5–10 мин: Ambassador-орги, даты доставки с окном отсечки — предупреждение за 1 ч и обработка в момент cutoff.
//
// ENV:
//   AMBASSADOR_CUTOFF_CRON_KEY (или AMBASSADOR_MINIMUM_CRON_KEY)
//   TBL_AMBASSADOR_DELIVERY_RUNS — имя таблицы лога (обязательно для идемпотентности)
//   RESEND / MAIL_FROM — письма
//   TELEGRAM_BOT_TOKEN — опционально, вместе с полем AmbassadorTelegramChatId в Organizations
//   APP_ORIGIN — ссылка в кабинет заказа
//   AMBASSADOR_CUTOFF_DRY_RUN=1 — только лог в ответе, без писем/отмен/патчей Airtable лога

const {
  json,
  listAll,
  TABLE,
  F,
  getAmbassadorCronSecret,
} = require('../utils');
const { computeAmbassadorTeamPaidStats } = require('../ambassador_team_core');
const {
  computeCutoffUtcForDeliveryDate,
  todayYmdInTimeZone,
  addDaysYmd,
  DEFAULT_TZ,
} = require('../cutoff_timezone');
const { formatOrgCutoffTimeLabel } = require('../org_cutoff_format');
const { sendResendEmail, sendTelegramMessage } = require('../ambassador_notify');
const {
  isLogEnabled,
  ensureDeliveryRun,
  patchDeliveryRun,
} = require('../ambassador_delivery_run');
const { systemCancelOrderAndRefund } = require('../ambassador_system_cancel');

const WARN_WINDOW_MS = 60 * 60 * 1000;
const CUTOFF_POST_WINDOW_MS = 25 * 60 * 1000;

function dryRun() {
  return String(process.env.AMBASSADOR_CUTOFF_DRY_RUN || '').trim() === '1';
}

function appOrigin() {
  return (process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || '').trim();
}

function orderLink(orgCode, employeeId, token) {
  const base = appOrigin().replace(/\/$/, '');
  if (!base || !employeeId || !token) return base || '';
  const u = new URL('/order', base);
  u.searchParams.set('org', orgCode);
  u.searchParams.set('employeeID', employeeId);
  u.searchParams.set('token', token);
  return u.toString();
}

function resolveAmbassadorContacts(orgRec, memberRecords) {
  const orgEmail = (orgRec?.fields?.[F.ORG_AMB_NOTIFY_EMAIL] || '').toString().trim();
  const tg = (orgRec?.fields?.[F.ORG_AMB_TELEGRAM_CHAT_ID] || '').toString().trim();
  if (orgEmail) return { email: orgEmail, telegramChatId: tg, ambassadorEmployee: null };
  const amb = (memberRecords || []).find(
    (m) => String(m.fields?.[F.EMP_ROLE] || '').trim() === 'Ambassador'
  );
  const em = (amb?.fields?.[F.EMP_EMAIL] || '').toString().trim();
  return { email: em, telegramChatId: tg, ambassadorEmployee: amb || null };
}

function ambassadorEmployeeLink(orgCode, memberRecords) {
  const amb = (memberRecords || []).find(
    (m) => String(m.fields?.[F.EMP_ROLE] || '').trim() === 'Ambassador'
  );
  if (!amb) return '';
  const tok = (amb.fields?.[F.EMP_TOKEN] || '').toString().trim();
  return orderLink(orgCode, amb.id, tok);
}

async function loadAmbassadorOrgs() {
  return listAll(TABLE.ORGS, {
    filterByFormula: `{${F.ORG_CONTRACT_TYPE}}='Ambassador'`,
    'fields[]': [
      F.ORG_ID,
      F.ORG_NAME,
      F.ORG_TZ,
      F.ORG_CUTOFF,
      F.ORG_CONTRACT_TYPE,
      F.ORG_TEAM_MIN_DELIVERY,
      F.ORG_AMB_NOTIFY_EMAIL,
      F.ORG_AMB_TELEGRAM_CHAT_ID,
    ],
  });
}

async function processOrgDeliveryWindow(orgRec, deliveryDateISO, nowUtc, results) {
  const orgCode = String(orgRec.fields?.[F.ORG_ID] || '').trim();
  if (!orgCode) return;

  const tz = (orgRec.fields?.[F.ORG_TZ] || '').trim() || DEFAULT_TZ;
  const cutoffRaw = orgRec.fields?.[F.ORG_CUTOFF];
  const cutoffUtc = computeCutoffUtcForDeliveryDate(deliveryDateISO, tz, cutoffRaw);
  if (!cutoffUtc) return;

  const msToCutoff = cutoffUtc.getTime() - nowUtc.getTime();
  const inWarnWindow = msToCutoff > 0 && msToCutoff <= WARN_WINDOW_MS;
  const inCutoffWindow = msToCutoff <= 0 && msToCutoff >= -CUTOFF_POST_WINDOW_MS;

  if (!inWarnWindow && !inCutoffWindow) return;

  const stats = await computeAmbassadorTeamPaidStats(orgCode, deliveryDateISO);
  if (!stats.orgRec) return;

  const min = stats.minDelivery;
  const paid = stats.paidCount;
  const shortBy = Math.max(0, min - paid);
  const contacts = resolveAmbassadorContacts(orgRec, stats.memberRecords);
  const dashLink = ambassadorEmployeeLink(orgCode, stats.memberRecords);
  const cutoffLabel = formatOrgCutoffTimeLabel(cutoffRaw) || 'отсечки';
  const orgName = (orgRec.fields?.[F.ORG_NAME] || orgCode).toString();

  const row = {
    org: orgCode,
    deliveryDate: deliveryDateISO,
    phase: inWarnWindow ? 'warn_window' : 'cutoff_window',
    msToCutoff,
    paid,
    min,
    shortBy,
    deliveryAllowed: stats.deliveryAllowed,
  };
  results.push(row);

  if (!isLogEnabled()) {
    row.logSkipped = 'configure TBL_AMBASSADOR_DELIVERY_RUNS';
    return;
  }

  const run = dryRun() ? { id: 'dry', fields: {} } : await ensureDeliveryRun(orgCode, deliveryDateISO);
  if (!run) {
    row.logError = 'could_not_ensure_run';
    return;
  }

  const runFields = run.fields || {};
  const warnAlready = Boolean(runFields[F.ADR_WARN_SENT]);
  const cutoffDone = Boolean(runFields[F.ADR_CUTOFF_DONE]);

  if (inWarnWindow) {
    if (stats.deliveryAllowed || warnAlready) return;
    const subject = `[${orgName}] Не хватает заказов до минимума на ${deliveryDateISO}`;
    const text = [
      `До отсечки (${cutoffLabel}, накануне доставки) осталось менее часа.`,
      `Оплаченных заказов команды: ${paid} из необходимых ${min} (не хватает ${shortBy}).`,
      `Добавьте оплаченные заказы до отсечки, иначе доставка на ${deliveryDateISO} будет отменена.`,
      dashLink ? `Кабинет заказов: ${dashLink}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (dryRun()) {
      row.warnDryRun = { subject, to: contacts.email };
      return;
    }

    if (contacts.email) {
      row.warnEmail = await sendResendEmail({
        to: contacts.email,
        subject,
        html: `<pre style="font-family:system-ui">${text.replace(/</g, '&lt;')}</pre>`,
        text,
      });
    }
    if (contacts.telegramChatId) {
      row.warnTelegram = await sendTelegramMessage(contacts.telegramChatId, text);
    }
    const sentOk =
      (contacts.email && row.warnEmail?.ok) ||
      (contacts.telegramChatId && row.warnTelegram?.ok);
    if (sentOk) {
      await patchDeliveryRun(run.id, { [F.ADR_WARN_SENT]: true });
    } else {
      row.warnNotSent = 'no_email_or_telegram_or_send_failed';
    }
    return;
  }

  // cutoff window
  if (cutoffDone) return;

  if (dryRun()) {
    row.cutoffDryRun = { wouldCancel: !stats.deliveryAllowed, orders: stats.orders.map((o) => o.id) };
    return;
  }

  if (stats.deliveryAllowed) {
    await patchDeliveryRun(run.id, {
      [F.ADR_CUTOFF_DONE]: true,
      [F.ADR_RESULT]: 'ok',
    });
    if (contacts.email) {
      const okText = `Минимум для доставки набран (${paid}/${min}). Доставка на ${deliveryDateISO} подтверждена.`;
      row.okEmail = await sendResendEmail({
        to: contacts.email,
        subject: `[${orgName}] Доставка на ${deliveryDateISO} — ок`,
        html: `<p>${okText}</p>`,
        text: okText,
      });
    }
    if (contacts.telegramChatId) {
      row.okTelegram = await sendTelegramMessage(
        contacts.telegramChatId,
        `✅ ${orgName}: доставка ${deliveryDateISO} — минимум набран (${paid}/${min}).`
      );
    }
    return;
  }

  // cancel delivery: cancel orders + refunds, then mark run, then emails
  const cancelResults = [];
  for (const o of stats.orders) {
    cancelResults.push(await systemCancelOrderAndRefund(o.id));
  }
  row.cancelledOrders = cancelResults;

  await patchDeliveryRun(run.id, {
    [F.ADR_CUTOFF_DONE]: true,
    [F.ADR_RESULT]: 'cancelled',
  });
  const empById = new Map(stats.memberRecords.map((m) => [m.id, m]));
  const emailed = new Set();
  const bodyEmp = [
    `Доставка на ${deliveryDateISO} не состоялась: не набран минимум оплаченных заказов для команды.`,
    'Ваш заказ на эту дату отменён.',
    'Если оплата уже прошла успешно, возврат средств будет обработан автоматически (см. банк / ЮKassa).',
  ].join('\n\n');

  for (const o of stats.orders) {
    const link = o.fields?.[F.ORDER_EMPLOYEE];
    const eid = Array.isArray(link) ? link[0] : link;
    if (!eid || emailed.has(eid)) continue;
    const emp = empById.get(eid);
    const to = (emp?.fields?.[F.EMP_EMAIL] || '').toString().trim();
    if (!to) continue;
    emailed.add(eid);
    row[`empEmail_${eid}`] = await sendResendEmail({
      to,
      subject: `[${orgName}] Доставка на ${deliveryDateISO} отменена`,
      html: `<pre style="font-family:system-ui">${bodyEmp.replace(/</g, '&lt;')}</pre>`,
      text: bodyEmp,
    });
  }

  if (contacts.email) {
    const ambText = [
      `Доставка на ${deliveryDateISO} отменена: оплаченных заказов ${paid}, нужно минимум ${min}.`,
      `Отменены заказы команды (${stats.orders.length} шт.), инициированы возвраты при успешных оплатах.`,
    ].join('\n\n');
    row.ambassadorCancelEmail = await sendResendEmail({
      to: contacts.email,
      subject: `[${orgName}] Доставка ${deliveryDateISO} отменена (минимум не набран)`,
      html: `<pre style="font-family:system-ui">${ambText.replace(/</g, '&lt;')}</pre>`,
      text: ambText,
    });
  }
  if (contacts.telegramChatId) {
    row.ambassadorCancelTg = await sendTelegramMessage(
      contacts.telegramChatId,
      `❌ ${orgName}: доставка ${deliveryDateISO} отменена. Оплачено ${paid}/${min}. Заказы отменены, возвраты запущены.`
    );
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    const secret = getAmbassadorCronSecret();
    if (!secret) {
      return json(res, 503, {
        ok: false,
        error: 'AMBASSADOR_CUTOFF_CRON_KEY not configured',
      });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const qKey = url.searchParams.get('key') || '';
    const hKey = req.headers['x-ambassador-cron-key'] || req.headers['x-reconcile-key'] || '';
    if (qKey !== secret && hKey !== secret) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }

    const nowUtc = new Date();
    const ambassadorOrgs = await loadAmbassadorOrgs();
    const results = [];

    for (const orgRec of ambassadorOrgs) {
      const tz = (orgRec.fields?.[F.ORG_TZ] || '').trim() || DEFAULT_TZ;
      const base = todayYmdInTimeZone(tz, nowUtc);
      for (let k = 0; k <= 5; k++) {
        const deliveryDateISO = addDaysYmd(base, k);
        await processOrgDeliveryWindow(orgRec, deliveryDateISO, nowUtc, results);
      }
    }

    return json(res, 200, {
      ok: true,
      dryRun: dryRun(),
      logTableConfigured: isLogEnabled(),
      processed: results.length,
      results,
    });
  } catch (e) {
    console.error('[ambassador_cutoff_cron]', e);
    return json(res, 500, { ok: false, error: e.message || String(e) });
  }
};
