// lib/handlers/payment_status.js — проверка статуса платежа

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  PAYMENTS: env('TBL_PAYMENTS', 'Payments'),
  ORDERS:   env('TBL_ORDERS',   'Orders'),
  BANKS:    env('TBL_BANKS',    'Banks'),
};

const F = {
  // Payments
  PAY_STATUS:         env('FLD_PAY_STATUS',         'Status'),
  PAY_EXTERNAL_ID:    env('FLD_PAY_EXTERNAL_ID',    'ExternalID'),
  PAY_PROVIDER:       env('FLD_PAY_PROVIDER',       'Provider'),
  PAY_PAID_AT:        env('FLD_PAY_PAID_AT',        'PaidAt'),
  PAY_ORDERS:         env('FLD_PAY_ORDERS',         'Orders'),

  // Banks
  BANK_ACQUIRING_PROVIDER: env('FLD_BANK_ACQUIRING_PROVIDER', 'AcquiringProvider'),
  BANK_TERMINAL_ID:        env('FLD_BANK_TERMINAL_ID',        'TerminalID'),
  BANK_API_KEY:            env('FLD_BANK_API_KEY',            'APIKey'),

  // Orders
  ORDER_STATUS: env('FLD_ORDER_STATUS', 'Status'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

const atHeaders = () => ({ Authorization: `Bearer ${APIKEY}`, 'Content-Type': 'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(t, params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(vv => usp.append(k, vv));
    else if (v != null) usp.append(k, v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPatch(t, body) {
  const r = await fetch(atUrl(t), { method: 'PATCH', headers: atHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a) => (Array.isArray(a) && a.length ? a[0] : null);

// Заглушка для проверки статуса платежа в банке
async function checkPaymentStatusAtBank({ provider, terminalId, apiKey, externalId }) {
  // TODO: Реальная интеграция с API банка
  // Пример для Tinkoff:
  // const response = await fetch('https://securepay.tinkoff.ru/v2/GetState', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     TerminalKey: terminalId,
  //     PaymentId: externalId,
  //   })
  // });
  // const data = await response.json();
  // return { status: data.Status, paidAt: data.PaidAt };

  // Заглушка:
  return { status: 'Completed', paidAt: new Date().toISOString() };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    if (!BASE || !APIKEY) return json(res, 500, { error: 'Missing AIRTABLE_* env' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const paymentID = url.searchParams.get('paymentID');

    if (!paymentID) return json(res, 400, { error: 'paymentID required' });

    // Получаем платёж
    const payResp = await atGet(TABLE.PAYMENTS, {
      filterByFormula: `RECORD_ID()='${paymentID}'`,
      maxRecords: 1,
      'fields[]': [
        F.PAY_STATUS,
        F.PAY_EXTERNAL_ID,
        F.PAY_PROVIDER,
        F.PAY_PAID_AT,
        F.PAY_ORDERS,
      ],
    });

    const payRec = one(payResp.records);
    if (!payRec) return json(res, 404, { error: 'payment not found' });

    const pf = payRec.fields || {};
    const currentStatus = pf[F.PAY_STATUS] || 'Pending';
    const externalId = pf[F.PAY_EXTERNAL_ID] || '';
    const providerLinks = pf[F.PAY_PROVIDER];
    const orderLinks = pf[F.PAY_ORDERS] || [];

    // Если уже Completed или Failed — возвращаем текущий статус
    if (currentStatus === 'Completed' || currentStatus === 'Failed' || currentStatus === 'Cancelled') {
      return json(res, 200, {
        ok: true,
        status: currentStatus,
        paidAt: pf[F.PAY_PAID_AT] || null,
      });
    }

    // Если нет ExternalID — не можем проверить
    if (!externalId) {
      return json(res, 200, {
        ok: true,
        status: currentStatus,
        paidAt: null,
      });
    }

    // Получаем банк
    if (!providerLinks || !Array.isArray(providerLinks) || providerLinks.length === 0) {
      return json(res, 400, { error: 'payment has no provider' });
    }

    const bankId = providerLinks[0];
    const bankResp = await atGet(TABLE.BANKS, {
      filterByFormula: `RECORD_ID()='${bankId}'`,
      maxRecords: 1,
      'fields[]': [
        F.BANK_ACQUIRING_PROVIDER,
        F.BANK_TERMINAL_ID,
        F.BANK_API_KEY,
      ],
    });

    const bankRec = one(bankResp.records);
    if (!bankRec) return json(res, 404, { error: 'bank not found' });

    const bf = bankRec.fields || {};
    const provider = bf[F.BANK_ACQUIRING_PROVIDER] || '';
    const terminalId = bf[F.BANK_TERMINAL_ID] || '';
    const apiKey = bf[F.BANK_API_KEY] || '';

    // Проверяем статус в банке
    const { status, paidAt } = await checkPaymentStatusAtBank({
      provider,
      terminalId,
      apiKey,
      externalId,
    });

    // Обновляем статус в Airtable
    if (status !== currentStatus) {
      const updateFields = { [F.PAY_STATUS]: status };
      if (status === 'Completed' && paidAt) {
        updateFields[F.PAY_PAID_AT] = paidAt;
      }

      await atPatch(TABLE.PAYMENTS, {
        typecast: true,
        records: [{ id: paymentID, fields: updateFields }]
      });

      // Если статус стал Completed — обновляем заказы на New
      if (status === 'Completed' && Array.isArray(orderLinks) && orderLinks.length > 0) {
        await atPatch(TABLE.ORDERS, {
          typecast: true,
          records: orderLinks.map(orderId => ({
            id: orderId,
            fields: { [F.ORDER_STATUS]: 'New' }
          }))
        });
      }
    }

    return json(res, 200, {
      ok: true,
      status,
      paidAt: paidAt || null,
    });

  } catch (e) {
    console.error('payment_status.js failed:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
