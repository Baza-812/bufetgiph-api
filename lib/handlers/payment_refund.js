// lib/handlers/payment_refund.js — возврат платежа (полный или частичный)

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  PAYMENTS: env('TBL_PAYMENTS', 'Payments'),
  BANKS:    env('TBL_BANKS',    'Banks'),
};

const F = {
  // Payments
  PAY_STATUS:          env('FLD_PAY_STATUS',          'Status'),
  PAY_EXTERNAL_ID:     env('FLD_PAY_EXTERNAL_ID',     'ExternalID'),
  PAY_PROVIDER:        env('FLD_PAY_PROVIDER',        'Provider'),
  PAY_AMOUNT:          env('FLD_PAY_AMOUNT',          'Amount'),
  PAY_REFUNDED_AMOUNT: env('FLD_PAY_REFUNDED_AMOUNT', 'RefundedAmount'),
  PAY_REFUNDED_AT:     env('FLD_PAY_REFUNDED_AT',     'RefundedAt'),

  // Banks
  BANK_ACQUIRING_PROVIDER: env('FLD_BANK_ACQUIRING_PROVIDER', 'AcquiringProvider'),
  BANK_TERMINAL_ID:        env('FLD_BANK_TERMINAL_ID',        'TerminalID'),
  BANK_API_KEY:            env('FLD_BANK_API_KEY',            'APIKey'),
};

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
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

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(res => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      try { res(d ? JSON.parse(d) : {}); } catch { res({}); }
    });
  });
}

// Заглушка для возврата платежа в банке
async function refundPaymentAtBank({ provider, terminalId, apiKey, externalId, amount }) {
  // TODO: Реальная интеграция с API банка
  // Пример для Tinkoff:
  // const response = await fetch('https://securepay.tinkoff.ru/v2/Cancel', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     TerminalKey: terminalId,
  //     PaymentId: externalId,
  //     Amount: amount * 100, // в копейках (для частичного возврата)
  //   })
  // });
  // const data = await response.json();
  // return { success: data.Success, refundedAt: new Date().toISOString() };

  // Заглушка:
  return { success: true, refundedAt: new Date().toISOString() };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

    if (!BASE || !APIKEY) return json(res, 500, { error: 'Missing AIRTABLE_* env' });

    const body = await readBody(req);
    const { paymentID, amount, reason } = body || {};

    if (!paymentID || !amount) {
      return json(res, 400, { error: 'paymentID, amount required' });
    }

    // Получаем платёж
    const payResp = await atGet(TABLE.PAYMENTS, {
      filterByFormula: `RECORD_ID()='${paymentID}'`,
      maxRecords: 1,
      'fields[]': [
        F.PAY_STATUS,
        F.PAY_EXTERNAL_ID,
        F.PAY_PROVIDER,
        F.PAY_AMOUNT,
        F.PAY_REFUNDED_AMOUNT,
      ],
    });

    const payRec = one(payResp.records);
    if (!payRec) return json(res, 404, { error: 'payment not found' });

    const pf = payRec.fields || {};
    const currentStatus = pf[F.PAY_STATUS] || 'Pending';
    const externalId = pf[F.PAY_EXTERNAL_ID] || '';
    const totalAmount = pf[F.PAY_AMOUNT] || 0;
    const alreadyRefunded = pf[F.PAY_REFUNDED_AMOUNT] || 0;
    const providerLinks = pf[F.PAY_PROVIDER];

    // Проверка: можно ли делать возврат
    if (currentStatus !== 'Completed' && currentStatus !== 'PartiallyRefunded') {
      return json(res, 400, { error: 'payment is not completed or partially refunded' });
    }

    if (!externalId) {
      return json(res, 400, { error: 'payment has no externalId' });
    }

    // Проверка: не превышает ли сумма возврата оставшуюся сумму
    const remainingAmount = totalAmount - alreadyRefunded;
    if (amount > remainingAmount) {
      return json(res, 400, { error: 'refund amount exceeds remaining amount' });
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

    // Делаем возврат в банке
    const { success, refundedAt } = await refundPaymentAtBank({
      provider,
      terminalId,
      apiKey,
      externalId,
      amount,
    });

    if (!success) {
      return json(res, 500, { error: 'refund failed at bank' });
    }

    // Обновляем платёж в Airtable
    const newRefundedAmount = alreadyRefunded + amount;
    const newStatus = newRefundedAmount >= totalAmount ? 'FullyRefunded' : 'PartiallyRefunded';

    await atPatch(TABLE.PAYMENTS, {
      typecast: true,
      records: [{
        id: paymentID,
        fields: {
          [F.PAY_STATUS]: newStatus,
          [F.PAY_REFUNDED_AMOUNT]: newRefundedAmount,
          [F.PAY_REFUNDED_AT]: refundedAt,
        }
      }]
    });

    return json(res, 200, {
      ok: true,
      refundedAmount: amount,
      totalRefunded: newRefundedAmount,
      newStatus,
      refundedAt,
    });

  } catch (e) {
    console.error('payment_refund.js failed:', e);
    return json(res, 500, { error: e.message || String(e) });
  }
};
