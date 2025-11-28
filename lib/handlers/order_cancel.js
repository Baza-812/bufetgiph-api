// api/order_cancel.js — Cancel order (with automatic refund for Starshiy program)

function env(k, d) { return process.env[k] ?? d; }

const BASE   = env('AIRTABLE_BASE_ID');
const APIKEY = env('AIRTABLE_API_KEY');

const TABLE = {
  ORDERS:    env('TBL_ORDERS',    'Orders'),
  EMPLOYEES: env('TBL_EMPLOYEES', 'Employees'),
  PAYMENTS:  env('TBL_PAYMENTS',  'Payments'),
  BANKS:     env('TBL_BANKS',     'Banks'),
};

const F = {
  // Employees
  EMP_ORG_LOOKUP: env('FLD_EMP_ORG_LOOKUP', 'OrgID (from Organization)'),
  EMP_TOKEN:      env('FLD_EMP_TOKEN',      'Order Token'),
  EMP_STATUS:     env('FLD_EMP_STATUS',     'Status'),
  EMP_ROLE:       env('FLD_EMP_ROLE',       'Role'),

  // Orders
  ORDER_EMPLOYEE:         env('FLD_ORDER_EMPLOYEE',         'Employee'),
  ORDER_STATUS:           env('FLD_ORDER_STATUS',           'Status'),
  ORDER_PAYMENT:          env('FLD_ORDER_PAYMENT',          'Payment'),
  ORDER_EMPLOYEE_PAYABLE: env('FLD_ORDER_EMPLOYEE_PAYABLE', 'EmployeePayableAmount'),

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
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

const atHeaders = () => ({ Authorization:`Bearer ${APIKEY}`, 'Content-Type':'application/json' });
const atUrl = (t) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(t)}`;

async function atGet(t, params={}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{
    if (Array.isArray(v)) v.forEach(vv=>usp.append(k,vv));
    else if (v!=null) usp.append(k,v);
  });
  const r = await fetch(`${atUrl(t)}?${usp}`, { headers: atHeaders() });
  if (!r.ok) throw new Error(`AT GET ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function atPatch(t, body) {
  const r = await fetch(atUrl(t), { method:'PATCH', headers:atHeaders(), body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`AT PATCH ${t}: ${r.status} ${await r.text()}`);
  return r.json();
}

const one = (a)=> (Array.isArray(a)&&a.length?a[0]:null);

async function readBody(req){
  if (req.body && typeof req.body==='object') return req.body;
  if (typeof req.body==='string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(res=>{
    let d=''; req.on('data',c=>d+=c); req.on('end',()=>{
      try{res(d?JSON.parse(d):{});}catch{res({});}
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
  //     Amount: amount * 100, // в копейках
  //   })
  // });
  // const data = await response.json();
  // return { success: data.Success, refundedAt: new Date().toISOString() };

  // Заглушка:
  return { success: true, refundedAt: new Date().toISOString() };
}

module.exports = async (req,res)=>{
  try{
    if (req.method==='OPTIONS') return json(res,200,{ok:true});
    if (req.method!=='POST') return json(res,405,{error:'POST only'});

    if (!BASE || !APIKEY) return json(res,500,{error:'Missing AIRTABLE_* env'});

    const body = await readBody(req);
    const { employeeID, org, token, orderId, reason } = body||{};

    if (!employeeID || !org || !token || !orderId) {
      return json(res,400,{error:'employeeID, org, token, orderId required'});
    }

    // Проверка сотрудника
    const empResp = await atGet(TABLE.EMPLOYEES, {
      filterByFormula: `RECORD_ID()='${employeeID}'`,
      'fields[]': [F.EMP_ORG_LOOKUP, F.EMP_TOKEN, F.EMP_STATUS, F.EMP_ROLE],
      maxRecords: 1,
    });
    const requester = one(empResp.records);
    if (!requester) return json(res,404,{error:'employee not found'});

    const ef = requester.fields||{};
    const reqOrg = (Array.isArray(ef[F.EMP_ORG_LOOKUP])? ef[F.EMP_ORG_LOOKUP][0]: ef[F.EMP_ORG_LOOKUP]) || null;
    if (reqOrg !== org) return json(res,403,{error:'employee not allowed (org mismatch)'});
    if (!ef[F.EMP_TOKEN] || ef[F.EMP_TOKEN] !== token) return json(res,403,{error:'invalid token'});
    if (ef[F.EMP_STATUS] && String(ef[F.EMP_STATUS]).toLowerCase()!=='active') {
      return json(res,403,{error:'employee not active'});
    }

    const isHR = String(ef[F.EMP_ROLE]||'').toUpperCase().includes('HR');

    // Получаем заказ
    const orderResp = await atGet(TABLE.ORDERS, {
      filterByFormula: `RECORD_ID()='${orderId}'`,
      maxRecords: 1,
      'fields[]': [
        F.ORDER_EMPLOYEE,
        F.ORDER_STATUS,
        F.ORDER_PAYMENT,
        F.ORDER_EMPLOYEE_PAYABLE,
      ],
    });

    const orderRec = one(orderResp.records);
    if (!orderRec) return json(res,404,{error:'order not found'});

    const of = orderRec.fields || {};
    const orderEmployees = of[F.ORDER_EMPLOYEE] || [];
    const orderStatus = of[F.ORDER_STATUS] || 'New';
    const paymentLinks = of[F.ORDER_PAYMENT] || [];
    const employeePayableAmount = of[F.ORDER_EMPLOYEE_PAYABLE] || 0;

    // Проверка прав: либо свой заказ, либо HR
    const isOwner = Array.isArray(orderEmployees) && orderEmployees.includes(employeeID);
    if (!isOwner && !isHR) {
      return json(res,403,{error:'not authorized to cancel this order'});
    }

    // Проверка: уже отменён?
    if (orderStatus === 'Cancelled') {
      return json(res,400,{error:'order already cancelled'});
    }

    // Если есть связанный платёж и он оплачен — делаем возврат
    let refundInitiated = false;
    let refundAmount = 0;

    if (paymentLinks && Array.isArray(paymentLinks) && paymentLinks.length > 0) {
      const paymentId = paymentLinks[0];

      const payResp = await atGet(TABLE.PAYMENTS, {
        filterByFormula: `RECORD_ID()='${paymentId}'`,
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
      if (payRec) {
        const pf = payRec.fields || {};
        const payStatus = pf[F.PAY_STATUS] || 'Pending';
        const externalId = pf[F.PAY_EXTERNAL_ID] || '';
        const totalAmount = pf[F.PAY_AMOUNT] || 0;
        const alreadyRefunded = pf[F.PAY_REFUNDED_AMOUNT] || 0;
        const providerLinks = pf[F.PAY_PROVIDER];

        // Если платёж завершён — делаем возврат
        if ((payStatus === 'Completed' || payStatus === 'PartiallyRefunded') && externalId) {
          const refundAmountForOrder = employeePayableAmount || 0;
          const remainingAmount = totalAmount - alreadyRefunded;

          if (refundAmountForOrder > 0 && refundAmountForOrder <= remainingAmount) {
            // Получаем банк
            if (providerLinks && Array.isArray(providerLinks) && providerLinks.length > 0) {
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
              if (bankRec) {
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
                  amount: refundAmountForOrder,
                });

                if (success) {
                  // Обновляем платёж
                  const newRefundedAmount = alreadyRefunded + refundAmountForOrder;
                  const newStatus = newRefundedAmount >= totalAmount ? 'FullyRefunded' : 'PartiallyRefunded';

                  await atPatch(TABLE.PAYMENTS, {
                    typecast: true,
                    records: [{
                      id: paymentId,
                      fields: {
                        [F.PAY_STATUS]: newStatus,
                        [F.PAY_REFUNDED_AMOUNT]: newRefundedAmount,
                        [F.PAY_REFUNDED_AT]: refundedAt,
                      }
                    }]
                  });

                  refundInitiated = true;
                  refundAmount = refundAmountForOrder;
                }
              }
            }
          }
        }
      }
    }

    // Обновляем статус заказа на Cancelled
    await atPatch(TABLE.ORDERS, {
      typecast: true,
      records: [{
        id: orderId,
        fields: { [F.ORDER_STATUS]: 'Cancelled' }
      }]
    });

    return json(res,200,{
      ok: true,
      orderId,
      cancelled: true,
      refundInitiated,
      refundAmount,
      reason: reason || 'user_cancel',
    });

  }catch(e){
    console.error('order_cancel.js failed:', e);
    return json(res,500,{ error: e.message || String(e) });
  }
};
