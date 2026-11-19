'use strict';

// Pay-by-phone and automatic refunds through the marupay package
// (https://github.com/iamshabell/marupay). All provider calls live here so the
// server only sees three plain outcomes: APPROVED, FAILED (definitely not paid)
// and UNKNOWN (timeout or network error: the money may or may not have moved).

const { getPaymentHandler, Currency } = require('marupay');

const PROVIDERS = {
  WAAFI: { label: 'EVC Plus, Zaad or Sahal', portal: 'WaafiPay' },
  EDAHAB: { label: 'eDahab', portal: 'eDahab' }
};

// Only answers that certainly mean "no money moved" count as FAILED. marupay throws its base
// VendorErrorException for every other reply too (an empty or unexpected body, an eDahab invoice that is
// still "Unpaid" while the customer has not entered the PIN yet, a refund that is not "Approved"), so those
// are UNKNOWN: the money may still move and someone must check before anything is released or resent.
const DEFINITE_VENDOR_ERRORS = new Set(['VendorAccountNotFound', 'VendorInsufficientBalance']);
// Waafi answers that mean the customer refused the PIN prompt.
const WAAFI_DECLINE_CODES = new Set(['E10205']);
const WAAFI_DECLINE_MESSAGES = new Set(['RCS_USER_REJECTED']);
const EDAHAB_DECLINED_INVOICE = /^(rejected|declined|cancell?ed|failed)$/i;

function isDefiniteFailure(error, provider, kind) {
  if (DEFINITE_VENDOR_ERRORS.has(error?.name)) return true;
  if (error?.name !== 'VendorErrorException' || kind === 'credit') return false;
  const code = error.code == null ? '' : String(error.code).trim();
  if (provider === 'WAAFI') return WAAFI_DECLINE_CODES.has(code) || WAAFI_DECLINE_MESSAGES.has(String(error.message || '').trim());
  if (provider === 'EDAHAB') return EDAHAB_DECLINED_INVOICE.test(String(error.message || '').trim());
  return false;
}

function waafiConfig(env = process.env) {
  const apiKey = String(env.WAAFI_API_KEY || '').trim();
  const secretKey = String(env.WAAFI_API_USER_ID || '').trim();
  const merchantId = String(env.WAAFI_MERCHANT_UID || '').trim();
  if (!apiKey || !secretKey || !merchantId) return null;
  return { apiKey, secretKey, merchantId, links: { baseUrl: String(env.MARUPAY_WAAFI_BASE_URL || 'https://api.waafipay.net/asm').trim() } };
}

function edahabConfig(env = process.env) {
  const apiKey = String(env.EDAHAB_API_KEY || '').trim();
  const secretKey = String(env.EDAHAB_SECRET_KEY || '').trim();
  const merchantId = String(env.EDAHAB_AGENT_CODE || '').trim();
  if (!apiKey || !secretKey || !merchantId) return null;
  return {
    apiKey, secretKey, merchantId,
    links: { baseUrl: String(env.EDAHAB_BASE_URL || 'https://edahab.net/api').trim(), requestUrl: '/api/issueinvoice?hash=', creditUrl: '/api/agentPayment?hash=' }
  };
}

function providerConfig(provider, env = process.env) {
  if (provider === 'WAAFI') return waafiConfig(env);
  if (provider === 'EDAHAB') return edahabConfig(env);
  return null;
}

function phonePaymentAvailability(env = process.env) {
  const phoneWaafi = Boolean(waafiConfig(env));
  const phoneEdahab = Boolean(edahabConfig(env));
  return { phoneWaafi, phoneEdahab, autoRefunds: phoneWaafi || phoneEdahab };
}

function phonePaymentTimeoutMs(env = process.env) {
  const value = Number(env.PHONE_PAYMENT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 55_000) : 45_000;
}

// Accepts 61xxxxxxx, 061xxxxxxx, 25261xxxxxxx, +25261xxxxxxx, 0025261xxxxxxx (spaces and dashes allowed).
// Returns +252XXXXXXXXX or null.
function normalizeSomaliPhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let digits = String(value).trim().replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('252')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return /^[679]\d{8}$/.test(digits) ? `+252${digits}` : null;
}

function providerLabel(provider) {
  return PROVIDERS[provider]?.label || 'mobile money';
}

function providerPortal(provider) {
  return PROVIDERS[provider]?.portal || 'payment provider';
}

function failureReason(error, provider, kind) {
  if (error?.name === 'VendorInsufficientBalance') {
    return kind === 'credit' ? 'The business wallet does not have enough balance to send this refund.' : 'Not enough balance in your wallet.';
  }
  if (error?.name === 'VendorAccountNotFound') return `This number is not registered for ${providerLabel(provider)}.`;
  return kind === 'credit' ? 'The provider did not accept this refund.' : 'The payment was not approved.';
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('The payment provider took too long to answer.'), { name: 'PhonePaymentTimeout' })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function run(kind, { provider, accountNumber, amountCents, currency = 'USD', description, timeoutMs }) {
  const config = providerConfig(provider);
  if (!config) throw Object.assign(new Error(`${providerLabel(provider)} payments are not set up.`), { statusCode: 503 });
  const phone = normalizeSomaliPhone(accountNumber);
  if (!phone) throw Object.assign(new Error('Enter a Somali mobile number, for example 61 234 5678.'), { statusCode: 400 });
  const handler = getPaymentHandler(provider === 'WAAFI' ? 'waafi' : 'edahab')(config);
  const options = {
    accountNumber: phone,
    amount: Math.round(Number(amountCents)) / 100,
    currency: currency === 'SLSH' ? Currency.SLSH : Currency.USD,
    description: String(description || 'SAFAR KAABE').slice(0, 120)
  };
  try {
    const result = await withTimeout(kind === 'credit' ? handler.credit(options) : handler.purchase(options), timeoutMs ?? phonePaymentTimeoutMs());
    return {
      outcome: 'APPROVED',
      transactionId: result?.transactionId != null ? String(result.transactionId) : null,
      referenceId: result?.referenceId != null ? String(result.referenceId) : null,
      accountNumber: phone
    };
  } catch (error) {
    if (isDefiniteFailure(error, provider, kind)) {
      return { outcome: 'FAILED', reason: failureReason(error, provider, kind), errorCode: error.code ? String(error.code) : error.name, accountNumber: phone };
    }
    // Timeouts, network errors and unexpected replies: the money may have moved. Never retry automatically.
    return {
      outcome: 'UNKNOWN',
      reason: error?.name === 'PhonePaymentTimeout' ? 'The payment provider took too long to answer.'
        : error?.name === 'VendorErrorException' ? 'The payment provider gave an unclear answer.' : 'The payment provider could not be reached.',
      errorCode: error?.code ? String(error.code) : error?.name || 'Error',
      accountNumber: phone
    };
  }
}

const chargePhone = options => run('purchase', options);
const creditPhone = options => run('credit', options);

module.exports = {
  PROVIDERS,
  chargePhone,
  creditPhone,
  normalizeSomaliPhone,
  phonePaymentAvailability,
  isDefiniteFailure,
  phonePaymentTimeoutMs,
  providerConfig,
  providerLabel,
  providerPortal
};
