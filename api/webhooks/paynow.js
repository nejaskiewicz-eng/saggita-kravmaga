// api/webhooks/paynow.js — PayNow (mBank) webhook handler
// PayNow wysyła POST po każdej zmianie statusu płatności.
// Docs: https://docs.paynow.pl/docs/v3/integration#payment-notifications

const { getPool } = require('../_lib/db');
const { verifyWebhookSignature } = require('../_lib/paynow');
const { sendMail, mailPaymentConfirmed } = require('../_lib/mail');

const SITE_URL = process.env.SITE_URL || 'https://akademiaobrony.pl';

module.exports = async (req, res) => {
  // PayNow wysyła tylko POST
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Odczytaj raw body (Vercel dostarcza req.body jako obiekt — skonstruuj z powrotem string)
    const bodyStr = JSON.stringify(req.body);
    const incomingSig = req.headers['signature'] || req.headers['Signature'] || '';

    // Weryfikacja podpisu
    if (!verifyWebhookSignature(bodyStr, incomingSig)) {
      console.warn('[webhook/paynow] Nieprawidłowy podpis!', { incomingSig, body: bodyStr.slice(0, 200) });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { paymentId, externalId, status } = req.body || {};
    console.log('[webhook/paynow]', { paymentId, externalId, status });

    // Obsługujemy tylko CONFIRMED (zapłacone)
    if (status !== 'CONFIRMED') {
      return res.status(200).end(); // 200 żeby PayNow nie ponawiał
    }

    const pool = getPool();

    // Znajdź rejestrację po externalId (= payment_ref)
    const { rows: [r] } = await pool.query(`
      SELECT reg.*, g.name AS group_name, l.city, l.address AS location_address,
             pp.name AS plan_name,
             s.day_name, s.time_start, s.time_end, s.address AS schedule_address
      FROM registrations reg
      LEFT JOIN groups g ON g.id = reg.group_id
      LEFT JOIN locations l ON l.id = reg.location_id
      LEFT JOIN price_plans pp ON pp.id = reg.price_plan_id
      LEFT JOIN schedules s ON s.id = reg.schedule_id
      WHERE reg.payment_ref = $1
    `, [externalId]);

    if (!r) {
      console.warn('[webhook/paynow] Nie znaleziono rejestracji dla externalId:', externalId);
      return res.status(200).end();
    }

    // Idempotentność — nie przetwarzaj ponownie jeśli już zapłacono
    if (r.payment_status === 'paid') {
      console.log('[webhook/paynow] Już oznaczono jako paid, pomijam:', externalId);
      return res.status(200).end();
    }

    // Zaktualizuj status płatności + status zapisu
    await pool.query(
      `UPDATE registrations
       SET payment_status = 'paid',
           status = CASE WHEN status = 'pending' THEN 'accepted' ELSE status END,
           updated_at = NOW()
       WHERE payment_ref = $1`,
      [externalId]
    );

    console.log('[webhook/paynow] Oznaczono jako paid:', externalId);

    // Wyślij email potwierdzający do kursanta
    if (r.email) {
      const scheduleLabel = r.day_name
        ? `${r.day_name} ${String(r.time_start || '').slice(0, 5)}–${String(r.time_end || '').slice(0, 5)}${r.schedule_address ? ' · ' + r.schedule_address : ''}`
        : null;

      const mail = mailPaymentConfirmed({
        first_name:       r.first_name,
        payment_ref:      externalId,
        plan_name:        r.plan_name,
        group_name:       r.group_name,
        city:             r.city,
        location_address: r.location_address,
        schedule_label:   scheduleLabel,
        total_amount:     r.total_amount,
        signup_fee:       r.signup_fee || 0,
        base_amount:      parseFloat(r.total_amount || 0) - parseFloat(r.signup_fee || 0),
      });

      try {
        await sendMail({ to: r.email, ...mail });
        console.log('[webhook/paynow] Mail potwierdzający wysłany do:', r.email);
      } catch (mailErr) {
        console.error('[webhook/paynow] Błąd wysyłki maila:', mailErr.message);
        // Nie zwracamy błędu — płatność jest potwierdzona, mail to bonus
      }
    }

    return res.status(200).end();

  } catch (e) {
    console.error('[webhook/paynow] ERROR:', e.message);
    // Zwracamy 200 żeby PayNow nie ponawiał bez końca przy błędach serwera
    return res.status(200).end();
  }
};
