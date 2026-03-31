// lib/handlers/ambassador_apply.js
// POST /api/ambassador/apply
// Форма заявки на участие в программе "Старший по обедам"

const { json, atPost, TABLE, F } = require('../utils');

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    const body = await readBody(req);
    console.log('[ambassador_apply] Received application:', body);

    const { fullName, phone, email, estimatedTeamSize, deliveryAddress } = body;

    // Валидация обязательных полей
    if (!fullName || !phone || !email) {
      return json(res, 400, {
        ok: false,
        error: 'Required fields missing: fullName, phone, email'
      });
    }

    // Валидация email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return json(res, 400, {
        ok: false,
        error: 'Invalid email format'
      });
    }

    // Валидация телефона (базовая)
    const phoneClean = phone.replace(/\D/g, '');
    if (phoneClean.length < 10) {
      return json(res, 400, {
        ok: false,
        error: 'Invalid phone number'
      });
    }

    console.log('[ambassador_apply] Creating application record...');

    // Создаем запись в AmbassadorApplications
    const createResp = await atPost(TABLE.AMBASSADOR_APPS, {
      typecast: true,
      records: [{
        fields: {
          [F.AMB_APP_FULL_NAME]: fullName.trim(),
          [F.AMB_APP_PHONE]: phone.trim(),
          [F.AMB_APP_EMAIL]: email.trim().toLowerCase(),
          [F.AMB_APP_TEAM_SIZE]: estimatedTeamSize || 10,
          [F.AMB_APP_ADDRESS]: deliveryAddress?.trim() || '',
          [F.AMB_APP_STATUS]: 'New',
          [F.AMB_APP_SUBMITTED_AT]: new Date().toISOString(),
        }
      }]
    });

    const applicationRecord = createResp.records?.[0];
    if (!applicationRecord) {
      throw new Error('Failed to create application record');
    }

    console.log('[ambassador_apply] Application created:', applicationRecord.id);

    // TODO: Отправить email уведомление администратору
    // Можно интегрировать Resend.com или SendGrid

    return json(res, 200, {
      ok: true,
      applicationId: applicationRecord.id,
      message: 'Заявка успешно отправлена! Мы свяжемся с вами в ближайшее время.',
    });

  } catch (err) {
    console.error('[ambassador_apply] ERROR:', err);
    return json(res, 500, {
      ok: false,
      error: err.message || 'Failed to submit application'
    });
  }
};
