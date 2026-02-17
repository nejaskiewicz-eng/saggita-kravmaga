// api/registration/action.js
// POST /api/registration/action  { payment_ref, action: 'pay_online'|'download_doc' }
// GET  /api/payment-document?payment_ref=X  → dokument HTML do pobrania
const { getPool } = require('../_lib/db');
const { sendMail, mailPobranieDokumentu, mailOplaciOnline, mailAdmin } = require('../_lib/mail');

const BANK_ACCOUNT = process.env.BANK_ACCOUNT || 'PL00 0000 0000 0000 0000 0000 0000';
const BANK_NAME    = process.env.BANK_NAME    || 'Akademia Obrony Saggita';
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'biuro@akademiaobrony.pl';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pool = getPool();

  // ── GET: generuj dokument płatniczy do pobrania ───────────────
  if (req.method === 'GET') {
    const { payment_ref } = req.query;
    if (!payment_ref) return res.status(400).json({ error: 'Brak payment_ref' });

    try {
      const { rows: [r] } = await pool.query(`
        SELECT reg.*, g.name AS group_name, l.city, pp.name AS plan_name
        FROM registrations reg
        LEFT JOIN groups g ON g.id = reg.group_id
        LEFT JOIN locations l ON l.id = reg.location_id
        LEFT JOIN price_plans pp ON pp.id = reg.price_plan_id
        WHERE reg.payment_ref = $1
      `, [payment_ref]);

      if (!r) return res.status(404).json({ error: 'Nie znaleziono zapisu.' });

      const date = new Date().toLocaleDateString('pl-PL');
      const amount = parseFloat(r.total_amount || 0).toFixed(2);

      // Zapisz akcję w bazie
      await pool.query(
        `UPDATE registrations SET finalize_action='download_doc', finalized_at=NOW(), updated_at=NOW() WHERE payment_ref=$1`,
        [payment_ref]
      );

      // Wyślij mail do kursanta
      sendMail({
        to: r.email,
        ...mailPobranieDokumentu({
          first_name: r.first_name,
          payment_ref: r.payment_ref,
          group_name: r.group_name,
          city: r.city,
          total_amount: r.total_amount,
          bank_account: BANK_ACCOUNT,
          bank_name: BANK_NAME,
        }),
      }).catch(e => console.error('[action/mail]', e));

      // Wyślij powiadomienie do admina
      sendMail({
        to: ADMIN_EMAIL,
        ...mailAdmin({
          first_name: r.first_name, last_name: r.last_name,
          email: r.email, phone: r.phone,
          group_name: r.group_name, city: r.city,
          payment_ref: r.payment_ref, total_amount: r.total_amount,
          is_waitlist: r.is_waitlist, action: 'download_doc',
        }),
      }).catch(e => console.error('[action/mail-admin]', e));

      // Generuj dokument HTML
      const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<title>Dokument płatniczy ${payment_ref}</title>
<style>
  body{font-family:Arial,sans-serif;margin:40px;color:#111;font-size:14px}
  .logo{font-size:18px;font-weight:bold;color:#c42000;margin-bottom:4px}
  h1{font-size:22px;border-bottom:2px solid #c42000;padding-bottom:8px;margin:20px 0}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  td{padding:9px 12px;border:1px solid #ddd}
  td:first-child{font-weight:bold;width:200px;background:#f8f8f8}
  .ref{font-size:22px;font-weight:bold;letter-spacing:3px;color:#c42000;margin:16px 0}
  .warn{margin-top:24px;padding:14px 16px;border:1px solid #f0d060;background:#fffbe6;font-size:13px;line-height:1.6}
  .footer{margin-top:40px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:12px}
  @media print{.noprint{display:none}}
</style>
</head>
<body>
<div class="logo">Akademia Obrony Saggita — Krav Maga</div>
<small style="color:#999">Dokument wygenerowany: ${date}</small>

<h1>Dokument płatniczy</h1>

<p><strong>Kod rejestracji:</strong></p>
<div class="ref">${r.payment_ref}</div>

<h2 style="font-size:16px;margin-top:24px;margin-bottom:4px">Dane kursanta</h2>
<table>
  <tr><td>Imię i nazwisko</td><td>${r.first_name} ${r.last_name}</td></tr>
  <tr><td>Email</td><td>${r.email || '—'}</td></tr>
  <tr><td>Telefon</td><td>${r.phone || '—'}</td></tr>
  <tr><td>Miasto</td><td>${r.city || '—'}</td></tr>
  <tr><td>Grupa</td><td>${r.group_name || '—'}</td></tr>
  <tr><td>Karnet</td><td>${r.plan_name || '—'}</td></tr>
  <tr><td>Kwota do wpłaty</td><td><strong style="font-size:16px">${amount} zł</strong></td></tr>
</table>

<h2 style="font-size:16px;margin-top:24px;margin-bottom:4px">Dane do przelewu</h2>
<table>
  <tr><td>Numer konta</td><td><strong>${BANK_ACCOUNT}</strong></td></tr>
  <tr><td>Odbiorca</td><td>${BANK_NAME}</td></tr>
  <tr><td>Tytuł przelewu</td><td><strong>${r.payment_ref} — ${r.first_name} ${r.last_name}</strong></td></tr>
  <tr><td>Kwota</td><td><strong>${amount} zł</strong></td></tr>
</table>

<div class="warn">
  <strong>⚠️ Ważne:</strong> Przelew należy wykonać w ciągu <strong>3 dni roboczych</strong> od daty rejestracji.<br>
  Po tym terminie rezerwacja przepada automatycznie.<br><br>
  Po opłaceniu prześlij potwierdzenie przelewu na: <strong>biuro@akademiaobrony.pl</strong>
</div>

<div class="footer">
  Akademia Obrony Saggita &nbsp;|&nbsp; biuro@akademiaobrony.pl &nbsp;|&nbsp; 510 930 460
</div>

<script class="noprint">
  window.onload = function() {
    window.print();
  };
</script>
</body>
</html>`;

      // Zwróć jako plik do pobrania
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);

    } catch (e) {
      console.error('[payment-document]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: zapis akcji "opłać online" ─────────────────────────
  if (req.method === 'POST') {
    try {
      const { payment_ref, action } = req.body || {};
      if (!payment_ref) return res.status(400).json({ error: 'Brak payment_ref' });
      if (!['pay_online', 'download_doc'].includes(action)) {
        return res.status(400).json({ error: 'Nieprawidłowa akcja' });
      }

      // Pobierz dane rejestracji
      const { rows: [r] } = await pool.query(`
        SELECT reg.*, g.name AS group_name, l.city
        FROM registrations reg
        LEFT JOIN groups g ON g.id = reg.group_id
        LEFT JOIN locations l ON l.id = reg.location_id
        WHERE reg.payment_ref = $1
      `, [payment_ref]);

      if (!r) return res.status(404).json({ error: 'Nie znaleziono zapisu.' });

      // Zapisz akcję w bazie
      await pool.query(
        `UPDATE registrations SET finalize_action=$1, finalized_at=NOW(), updated_at=NOW() WHERE payment_ref=$2`,
        [action, payment_ref]
      );

      // Wyślij mail do kursanta (tylko dla pay_online)
      if (action === 'pay_online') {
        sendMail({
          to: r.email,
          ...mailOplaciOnline({
            first_name: r.first_name,
            payment_ref: r.payment_ref,
            group_name: r.group_name,
            city: r.city,
            total_amount: r.total_amount,
          }),
        }).catch(e => console.error('[action/mail]', e));

        // Powiadomienie admina
        sendMail({
          to: ADMIN_EMAIL,
          ...mailAdmin({
            first_name: r.first_name, last_name: r.last_name,
            email: r.email, phone: r.phone,
            group_name: r.group_name, city: r.city,
            payment_ref: r.payment_ref, total_amount: r.total_amount,
            is_waitlist: r.is_waitlist, action: 'pay_online',
          }),
        }).catch(e => console.error('[action/mail-admin]', e));
      }

      return res.status(200).json({ success: true, action });

    } catch (e) {
      console.error('[registration/action]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};