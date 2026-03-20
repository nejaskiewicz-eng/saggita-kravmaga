// api/_lib/paynow.js — PayNow (mBank) client
// Docs: https://docs.paynow.pl/docs/v3/integration

const crypto = require('crypto');

const API_KEY       = process.env.PAYNOW_API_KEY;
const SIG_KEY       = process.env.PAYNOW_SIGNATURE_KEY;
const SANDBOX       = process.env.PAYNOW_SANDBOX === 'true';
const BASE_URL      = SANDBOX
  ? 'https://api.sandbox.paynow.pl'
  : 'https://api.paynow.pl';

// ── Oblicz podpis HMAC-SHA256 ────────────────────────────────────────────────
// Payload: { headers: { Api-Key, Idempotency-Key }, parameters: {}, body: "..." }
// Wynik: Base64(HMAC-SHA256(payload_json, SIG_KEY))
function calcSignature(apiKey, idempotencyKey, bodyStr) {
  const payload = JSON.stringify({
    headers:    { 'Api-Key': apiKey, 'Idempotency-Key': idempotencyKey },
    parameters: {},
    body:       bodyStr,
  });
  return crypto
    .createHmac('sha256', SIG_KEY)
    .update(payload)
    .digest('base64');
}

// ── Weryfikuj podpis webhooka ────────────────────────────────────────────────
// PayNow wysyła nagłówek Signature = Base64(HMAC-SHA256(body_string, SIG_KEY))
function verifyWebhookSignature(rawBody, incomingSignature) {
  const expected = crypto
    .createHmac('sha256', SIG_KEY)
    .update(rawBody)
    .digest('base64');
  return expected === incomingSignature;
}

// ── Utwórz płatność ──────────────────────────────────────────────────────────
// amount:       kwota w GROSZACH (np. 24000 = 240 zł)
// externalId:   payment_ref (np. "KM-AB12-CD34")
// description:  opis widoczny dla płatnika
// email:        e-mail kupującego
// firstName:    imię
// lastName:     nazwisko
// continueUrl:  URL powrotu po płatności
// Returns: { paymentId, redirectUrl } lub rzuca Error
async function createPayment({ amount, externalId, description, email, firstName, lastName, continueUrl }) {
  if (!API_KEY || !SIG_KEY) {
    throw new Error('Brak konfiguracji PayNow (PAYNOW_API_KEY / PAYNOW_SIGNATURE_KEY)');
  }

  const idempotencyKey = crypto.randomUUID();
  const body = {
    amount,
    currency:    'PLN',
    externalId,
    description,
    continueUrl,
    buyer: {
      email,
      firstName,
      lastName,
    },
  };
  const bodyStr = JSON.stringify(body);
  const signature = calcSignature(API_KEY, idempotencyKey, bodyStr);

  const resp = await fetch(`${BASE_URL}/v3/payments`, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Api-Key':         API_KEY,
      'Idempotency-Key': idempotencyKey,
      'Signature':       signature,
    },
    body: bodyStr,
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = json?.errors?.[0]?.message || json?.message || `HTTP ${resp.status}`;
    throw new Error(`PayNow error: ${msg}`);
  }

  return {
    paymentId:   json.paymentId,
    redirectUrl: json.redirectUrl,
    status:      json.status,
  };
}

module.exports = { createPayment, verifyWebhookSignature };
