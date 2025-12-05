const { F, TABLE, atGet, env } = require('./utils');

/**
 * Получает credentials для банка
 */
function getBankCredentials(bankRec) {
  const provider = bankRec.fields[F.BANK_ACQUIRING_PROVIDER];
  const credSource = bankRec.fields[F.BANK_CREDENTIALS_SOURCE] || 'Airtable';
  
  if (credSource === 'ENV') {
    const prefix = bankRec.fields[F.BANK_ENV_PREFIX] || provider.toUpperCase();
    const merchantId = env(`${prefix}_SHOP_ID`) || env(`${prefix}_MERCHANT_ID`);
    const apiKey = env(`${prefix}_SECRET_KEY`) || env(`${prefix}_API_KEY`);
    
    if (!merchantId || !apiKey) {
      throw new Error(`Missing ENV credentials for ${prefix}: ${prefix}_SHOP_ID and ${prefix}_SECRET_KEY`);
    }
    
    return { merchantId, apiKey };
  }
  
  // Из Airtable
  const merchantId = bankRec.fields[F.BANK_MERCHANT_ID];
  const apiKey = bankRec.fields[F.BANK_API_KEY];
  
  if (!merchantId || !apiKey) {
    throw new Error(`Missing Airtable credentials for bank ${bankRec.id}`);
  }
  
  return { merchantId, apiKey };
}

/**
 * Получает настройки банка для организации
 */
async function getBankSettings(orgRecordId) {
  const orgRec = await atGet(TABLE.ORGS, orgRecordId);
  const bankIds = orgRec.fields[F.ORG_BANK] || [];
  
  if (!bankIds.length) {
    throw new Error('Organization has no bank configured');
  }
  
  const bankRec = await atGet(TABLE.BANKS, bankIds[0]);
  
  if (!bankRec.fields[F.BANK_IS_ACTIVE]) {
    throw new Error('Bank is not active');
  }
  
  const credentials = getBankCredentials(bankRec);
  
  return {
    bankRecordId: bankRec.id,
    provider: bankRec.fields[F.BANK_ACQUIRING_PROVIDER],
    merchantId: credentials.merchantId,
    apiKey: credentials.apiKey,
    terminalId: bankRec.fields[F.BANK_TERMINAL_ID],
    baseUrl: bankRec.fields[F.BANK_PAYMENT_PAGE_BASE_URL],
  };
}

/**
 * Создаёт платёж через провайдера
 */
async function createPayment({ orgRecordId, amount, description, returnUrl, metadata }) {
  const bank = await getBankSettings(orgRecordId);
  
  switch (bank.provider) {
    case 'YooKassa':
      return createYooKassaPayment({ bank, amount, description, returnUrl, metadata });
    
    case 'Tinkoff':
      return createTinkoffPayment({ bank, amount, description, returnUrl, metadata });
    
    case 'Sber':
      return createSberPayment({ bank, amount, description, returnUrl, metadata });
    
    default:
      throw new Error(`Unsupported payment provider: ${bank.provider}`);
  }
}

/**
 * YooKassa
 */
async function createYooKassaPayment({ bank, amount, description, returnUrl, metadata }) {
  const shopId = bank.merchantId;
  const secretKey = bank.apiKey;
  
  // Генерируем уникальный idempotence key
  const idempotenceKey = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  // Формируем Basic Auth: shopId:secretKey в base64
  const authString = `${shopId}:${secretKey}`;
  const authHeader = `Basic ${Buffer.from(authString).toString('base64')}`;
  
  console.log('💳 Creating YooKassa payment:', {
    shopId,
    amount: amount.toFixed(2),
    description,
    idempotenceKey,
  });
  
  const requestBody = {
    amount: {
      value: amount.toFixed(2),
      currency: 'RUB',
    },
    confirmation: {
      type: 'redirect',
      return_url: returnUrl,
    },
    capture: true,
    description,
    metadata,
  };
  
  console.log('📤 Request body:', JSON.stringify(requestBody, null, 2));
  
  const response = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotence-Key': idempotenceKey,
      'Authorization': authHeader,
    },
    body: JSON.stringify(requestBody),
  });
  
  const responseText = await response.text();
  
  console.log('📥 YooKassa response:', {
    status: response.status,
    statusText: response.statusText,
    body: responseText,
  });
  
  if (!response.ok) {
    throw new Error(`YooKassa API error (${response.status}): ${responseText}`);
  }
  
  const payment = JSON.parse(responseText);
  
  console.log('✅ Payment created:', {
    id: payment.id,
    status: payment.status,
    confirmation_url: payment.confirmation?.confirmation_url,
  });
  
  return {
    externalId: payment.id,
    paymentLink: payment.confirmation.confirmation_url,
    status: payment.status, // 'pending'
    provider: 'YooKassa',
    bankRecordId: bank.bankRecordId,
  };
}

/**
 * Tinkoff (заглушка)
 */
async function createTinkoffPayment({ bank, amount, description, returnUrl, metadata }) {
  // TODO: реализовать интеграцию с Tinkoff Acquiring API
  throw new Error('Tinkoff integration not implemented yet');
}

/**
 * Sber (заглушка)
 */
async function createSberPayment({ bank, amount, description, returnUrl, metadata }) {
  // TODO: реализовать интеграцию с Sber Acquiring API
  throw new Error('Sber integration not implemented yet');
}

module.exports = {
  getBankSettings,
  createPayment,
};
