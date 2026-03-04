const { getPool } = require('../_lib/db');
const { sendMail, mailKursant, mailPayOnlineChosen, mailPaymentConfirmed } = require('../_lib/mail');

const BANK_ACCOUNT = process.env.BANK_ACCOUNT || '21 1140 2004 0000 3902 3890 8895';
const BANK_NAME    = process.env.BANK_NAME    || 'Akademia Obrony Saggita';
const SITE_URL     = process.env.SITE_URL     || 'https://akademiaobrony.pl';
const API_BASE     = process.env.API_URL      || `${SITE_URL}/api`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pool = getPool();

  // ── GET: generuj dokument płatniczy HTML (do wydruku) ─────────────────────
  if (req.method === 'GET') {
    const { payment_ref, action: docAction, months: docMonths, monthly_rate: docMonthlyRate, signup_fee: docSignupFee } = req.query;
    if (!payment_ref) return res.status(400).json({ error: 'Brak payment_ref' });

    try {
      const { rows: [r] } = await pool.query(`
        SELECT reg.*, g.name AS group_name, l.city, l.address AS location_address,
               pp.name AS plan_name
        FROM registrations reg
        LEFT JOIN groups g ON g.id = reg.group_id
        LEFT JOIN locations l ON l.id = reg.location_id
        LEFT JOIN price_plans pp ON pp.id = reg.price_plan_id
        WHERE reg.payment_ref = $1
      `, [payment_ref]);

      if (!r) return res.status(404).json({ error: 'Nie znaleziono zapisu.' });

      // zmiana 8: korekta adresu Świdnica
      if (r.city && String(r.city).toLowerCase().includes('świdnica')) {
        r.location_address = 'ul. Długa 33, 58-100 Świdnica';
      }
      const totalAmount = parseFloat(r.total_amount || 0);
      const isScheduleDoc = docAction === 'schedule_doc';
      const isMonthlyDoc  = docAction === 'monthly_doc';
      // Jeśli dokument miesięczny — pokaż kwotę pierwszego miesiąca
      let displayAmount = totalAmount;
      let docTitle = 'Dokument płatniczy';
      let docNote = '';
      const fmt = (v) => parseFloat(v||0).toFixed(2);
      const pMonths = parseInt(docMonths || 1);
      const pRate = docMonthlyRate ? parseFloat(docMonthlyRate) : null;
      // signup_fee: najpierw z URL (frontend wie więcej), fallback do DB
      const pSignupFee = docSignupFee !== undefined ? parseFloat(docSignupFee) : parseFloat(r.signup_fee || 0);

      if (isMonthlyDoc && pRate) {
        displayAmount = pRate + pSignupFee;
        docTitle = 'Dokument płatniczy — 1. miesiąc';
        docNote = `<p style="margin:8px 0;font-size:13px;color:#555">Dotyczy <strong>pierwszej wpłaty</strong>. Kolejne: ${pMonths - 1} × ${fmt(pRate)} zł/mies. — łącznie ${fmt(totalAmount)} zł.</p>`;
      } else if (isScheduleDoc) {
        docTitle = 'Harmonogram wpłat';
      }

      const fmt2 = (v) => parseFloat(v||0).toFixed(2);
      const amount = fmt2(displayAmount);
      const onlineUrl = `${SITE_URL}/kvcennik`;
      const date = new Date().toLocaleDateString('pl-PL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

      // Generuj tabelę harmonogramu dla schedule_doc
      let scheduleTable = '';
      if (isScheduleDoc && pRate && pMonths > 1) {
        const now = new Date();
        const day = now.getDate();
        // Pierwsza połowa miesiąca (1-15): zaczynam od bieżącego miesiąca
        // Druga połowa (16+): zaczynam od przyszłego miesiąca
        const startOffset = day > 15 ? 1 : 0;

        let rows = '';
        for (let i = 0; i < pMonths; i++) {
          const monthOffset = startOffset + i;
          const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
          const label = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
          const amt = i === 0 ? (pRate + pSignupFee) : pRate;
          const note = i === 0 && pSignupFee > 0 ? ' (karnet + wpisowe)' : '';

          let deadline;
          if (i === 0 && startOffset === 0) {
            // Bieżący miesiąc, 1. połowa — płatne natychmiast (w ciągu 3 dni)
            deadline = 'w ciągu 3 dni roboczych';
          } else {
            // Ostatni dzień miesiąca poprzedzającego opłacany miesiąc
            const prevEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset, 0);
            const prevLabel = prevEnd.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });
            deadline = `do ${prevLabel}`;
          }

          rows += `<tr><td>${i+1}.</td><td>${label}</td><td>${deadline}</td><td style="font-weight:bold;color:#c42000">${fmt(amt)} zł${note}</td></tr>`;
        }
        scheduleTable = `<h2 style="margin-top:24px;font-size:16px">📅 Harmonogram wpłat</h2>
<table>
<thead><tr style="background:#1a1a1a;color:#fff"><th style="padding:8px 10px;text-align:left">#</th><th style="padding:8px 10px;text-align:left">Miesiąc</th><th style="padding:8px 10px;text-align:left">Termin</th><th style="padding:8px 10px;text-align:left">Kwota</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="margin-top:8px;font-size:12px;color:#666">Łącznie za cały okres: <strong>${fmt2(totalAmount)} zł</strong></p>`;
      }

      const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;margin:40px;color:#111;font-size:14px}
h1{font-size:22px;border-bottom:2px solid #c42000;padding-bottom:8px;margin-bottom:20px}
.logo{font-size:18px;font-weight:bold;color:#c42000;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin-top:16px}
td,th{padding:8px 10px;border:1px solid #ddd}td:first-child{font-weight:bold;width:200px;background:#f8f8f8}
.ref{font-size:20px;font-weight:bold;letter-spacing:2px;color:#c42000;margin:16px 0}
.note{margin-top:24px;padding:12px;border:1px solid #ddd;background:#fffbe6;font-size:13px}
.footer{margin-top:40px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:12px}
.online-btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#c42000;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold}
@media print{.online-btn{display:none}}
</style></head><body>
<div class="logo">Akademia Obrony Saggita — Krav Maga</div>
<p style="color:#666;font-size:12px">Dokument wygenerowany: ${date}</p>
<h1>${docTitle}</h1>
${docNote}
<p class="ref">Kod: ${r.payment_ref}</p>
<table>
<tr><td>Imię i nazwisko</td><td>${r.first_name} ${r.last_name}</td></tr>
<tr><td>Email</td><td>${r.email || '—'}</td></tr>
<tr><td>Telefon</td><td>${r.phone || '—'}</td></tr>
<tr><td>Miasto</td><td>${r.city || '—'}</td></tr>
<tr><td>Adres</td><td>${r.location_address || '—'}</td></tr>
<tr><td>Grupa</td><td>${r.group_name || '—'}</td></tr>
<tr><td>Karnet</td><td>${r.plan_name || '—'}</td></tr>
${!isScheduleDoc ? `<tr><td>Kwota do wpłaty</td><td><strong>${amount} zł</strong></td></tr>` : ''}
</table>
${isScheduleDoc ? scheduleTable : `<h2 style="margin-top:24px;font-size:16px">Dane do przelewu</h2>
<table>
<tr><td>Numer konta</td><td>${BANK_ACCOUNT}</td></tr>
<tr><td>Odbiorca</td><td>${BANK_NAME}</td></tr>
<tr><td>Tytuł przelewu</td><td><strong>${r.payment_ref} — ${r.first_name} ${r.last_name}</strong></td></tr>
<tr><td>Kwota</td><td><strong>${amount} zł</strong></td></tr>
</table>`}
<div class="note"><strong>Ważne:</strong> Przelew w ciągu <strong>3 dni roboczych</strong>.
Po tym terminie rezerwacja przepada.<br>
Po przelewie wyślij potwierdzenie na: <strong>biuro@akademiaobrony.pl</strong><br>
Kontakt: <strong>biuro@akademiaobrony.pl</strong> · <strong>510 930 460</strong></div>
${!isScheduleDoc ? `<a href="${onlineUrl}" class="online-btn">💳 Przejdź do płatności online</a>` : ''}
<div class="footer">Akademia Obrony Saggita | biuro@akademiaobrony.pl | 510 930 460</div>
<div style="margin:20px 0;text-align:center"><button onclick="window.print()" style="padding:10px 28px;background:#c42000;color:#fff;border:none;border-radius:4px;font-size:14px;font-weight:bold;cursor:pointer">🖨️ Drukuj / Zapisz jako PDF</button></div>
</body></html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: akcja (wybór metody płatności / potwierdzenie) ──────────────────
  if (req.method === 'POST') {
    try {
      const { payment_ref, action, pay_url, payment_mode, months, monthly_rate, signup_fee: bodySignupFee, reminders } = req.body || {};
      if (!payment_ref) return res.status(400).json({ error: 'Brak payment_ref' });
      const VALID = ['pay_online', 'download_doc', 'payment_confirmed', 'schedule_doc'];
      if (!VALID.includes(action)) return res.status(400).json({ error: 'Nieprawidłowa akcja' });

      // Pobierz pełne dane rejestracji
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
      `, [payment_ref]);

      if (!r) return res.status(404).json({ error: 'Nie znaleziono zapisu.' });

      // zmiana 8: korekta adresu Świdnica
      if (r.city && String(r.city).toLowerCase().includes('świdnica')) {
        r.location_address = 'ul. Długa 33, 58-100 Świdnica';
      }

      // Zaktualizuj rekord
      await pool.query(
        `UPDATE registrations SET finalize_action=$1, finalized_at=NOW(), updated_at=NOW(),
         payment_status = CASE WHEN $1='payment_confirmed' THEN 'paid' ELSE payment_status END
         WHERE payment_ref=$2`,
        [action, payment_ref]
      );

      // Przygotuj dane do maila
      const scheduleLabel = r.day_name
        ? `${r.day_name} ${String(r.time_start||'').slice(0,5)}–${String(r.time_end||'').slice(0,5)}${r.schedule_address ? ' · ' + r.schedule_address : ''}`
        : null;
      const docUrl    = `${API_BASE}/registration/action?payment_ref=${payment_ref}`;
      const onlineUrl = pay_url || `${SITE_URL}/kvcennik`;

      // Wyślij odpowiedni mail do kursanta
      let userMail = null;

      // Dane kontraktowe (przekazane z frontendu lub wyliczone)
      const pMonths      = parseInt(months || r.months || 1);
      const pMonthlyRate = monthly_rate ? parseFloat(monthly_rate)
                         : (pMonths > 1 ? Math.round(parseFloat(r.total_amount||0) / pMonths) : parseFloat(r.total_amount||0));
      // signup_fee: frontend przekazuje przez body, fallback do DB
      const pSignupFee   = bodySignupFee !== undefined ? parseFloat(bodySignupFee) : parseFloat(r.signup_fee || 0);
      const pMode        = payment_mode || r.payment_mode || null;
      const pReminders   = reminders !== false;

      const contractData = {
        first_name:   r.first_name,
        payment_ref,
        plan_name:    r.plan_name,
        group_name:   r.group_name,
        city:         r.city,
        total_amount: r.total_amount,
        bank_account: BANK_ACCOUNT,
        bank_name:    BANK_NAME,
        payment_mode: pMode,
        months:       pMonths,
        monthly_rate: pMonthlyRate,
        signup_fee:   pSignupFee,
        reminders:    pReminders,
        doc_url:      docUrl,
        online_url:   onlineUrl,
      };

      if (action === 'download_doc') {
        // Mail z danymi do przelewu — wysyłany po kliknięciu zielonego przycisku
        userMail = mailKursant(contractData);
      } else if (action === 'schedule_doc') {
        // Mail z harmonogramem miesięcznym — wysyłany po kliknięciu zielonego przycisku
        userMail = mailKursant({ ...contractData, payment_mode: 'monthly' });
      } else if (action === 'pay_online') {
        // Brak maila — użytkownik dopiero jest przekierowywany do bramki płatności.
        // Mail zostanie wysłany przez payment_confirmed po powrocie z płatności.
        userMail = null;
      } else if (action === 'payment_confirmed') {
        userMail = mailPaymentConfirmed({
          first_name:        r.first_name,
          payment_ref,
          plan_name:         r.plan_name,
          group_name:        r.group_name,
          city:              r.city,
          location_address:  r.location_address,
          schedule_label:    scheduleLabel,
          total_amount:      r.total_amount,
          signup_fee:        r.signup_fee || 0,
          base_amount:       parseFloat(r.total_amount || 0) - parseFloat(r.signup_fee || 0),
        });
      }

      if (userMail) {
        sendMail({ to: r.email, ...userMail }).catch(e => console.error('[action/mail]', e));
      }

      return res.status(200).json({ success: true, action });
    } catch (e) {
      console.error('[action]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
