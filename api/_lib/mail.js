// api/_lib/mail.js — CommonJS
// Wysyłka przez Resend API (fetch natywny Node 18+)

const SITE_URL = process.env.SITE_URL || 'https://akademiaobrony.pl';

async function sendMail({ to, subject, html }) {
  const key  = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Akademia Obrony Saggita <onboarding@resend.dev>';
  if (!key) { console.warn('[mail] Brak RESEND_API_KEY'); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) console.error('[mail] Resend error:', res.status, await res.text());
  } catch (e) { console.error('[mail] Fetch error:', e.message); }
}

function fmt(amount) {
  return parseFloat(amount || 0).toFixed(2).replace('.', ',') + ' zł';
}

function googleMapsUrl(address, city) {
  const q = encodeURIComponent([address, city].filter(Boolean).join(', '));
  return 'https://www.google.com/maps/search/?api=1&query=' + q;
}

function baseStyle() {
  return `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f4f4;color:#1a1a1a}
.wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.10)}
.hdr{background:#1a1a1a;padding:28px 32px}
.hdr .brand{color:#fff;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;opacity:.6}
.hdr h1{color:#fff;font-size:22px;font-weight:700;margin-top:6px}
.accent{color:#c42000}
.body{padding:28px 32px}
.hi{font-size:16px;margin-bottom:20px}
.card{background:#f8f8f8;border-radius:6px;padding:16px 18px;margin:16px 0}
.card-title{font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:#888;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #eee;font-size:14px}
.row:last-child{border-bottom:none}
.row b{color:#333;white-space:nowrap}
.row span{color:#555;text-align:right}
.total-row{padding-top:10px;margin-top:4px}
.total-row b{font-size:16px;color:#1a1a1a}
.total-row span{font-size:18px;font-weight:800;color:#c42000}
.ref{display:inline-block;background:#f0f0f0;border:1px solid #ddd;border-radius:4px;padding:6px 12px;font-family:monospace;font-size:15px;font-weight:700;letter-spacing:.08em;color:#1a1a1a;margin:8px 0}
.btn{display:inline-block;padding:13px 22px;border-radius:6px;font-weight:700;font-size:14px;text-decoration:none;margin:6px 4px 6px 0;color:#fff}
.btn-red{background:#c42000}
.btn-blue{background:#4285F4}
.btn-outline{background:#fff;color:#1a1a1a;border:1.5px solid #ccc}
.alert{background:#fffbe6;border:1px solid #f0c040;border-radius:6px;padding:14px 16px;margin:16px 0;font-size:13px;line-height:1.6}
.alert strong{color:#a06000}
.alert-ok{background:#f0fdf4;border-color:#6ee7b7}
.alert-ok strong{color:#065f46}
p{line-height:1.6;font-size:14px;margin:10px 0}
.ftr{padding:18px 32px;background:#f4f4f4;font-size:12px;color:#888;border-top:1px solid #e8e8e8}
.ftr a{color:#888}
</style>`;
}

function ftr() {
  return `<div class="ftr">
<p style="margin-bottom:8px;font-size:12px;color:#aaa">To jest wiadomość automatyczna. W razie jakichkolwiek pytań prosimy o kontakt na <a href="mailto:biuro@akademiaobrony.pl" style="color:#aaa">biuro@akademiaobrony.pl</a>.</p>
<strong>Akademia Obrony Saggita</strong><br>
<a href="mailto:biuro@akademiaobrony.pl">biuro@akademiaobrony.pl</a> &nbsp;·&nbsp; 510 930 460<br>
<a href="${SITE_URL}">${SITE_URL}</a></div>`;
}

// ── MAIL 1: Płatność potwierdzona (po opłaceniu online) ─────────────────────
function mailPaymentConfirmed({ first_name, payment_ref, plan_name, group_name, city,
  location_address, schedule_label, total_amount, signup_fee, base_amount }) {

  const mapsUrl = googleMapsUrl(location_address, city);
  const hasFee  = parseFloat(signup_fee || 0) > 0;

  return {
    subject: '✅ Akademia Obrony Saggita — potwierdzenie rezerwacji',
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Akademia Obrony Saggita</div><h1>Potwierdzenie rezerwacji <span class="accent">✓</span></h1></div>
<div class="body">
<p class="hi">Cześć <strong>${first_name}</strong>! 👊</p>
<p>Twoja płatność została zaksięgowana. Jesteś oficjalnie zapisany/a. Do zobaczenia na macie!</p>
<div class="card">
  <div class="card-title">Szczegóły zapisu</div>
  <div class="row"><b>Karnet</b><span>${plan_name || '—'}</span></div>
  <div class="row"><b>Grupa</b><span>${group_name || '—'}</span></div>
  <div class="row"><b>Miasto</b><span>${city || '—'}</span></div>
  ${schedule_label ? `<div class="row"><b>Termin</b><span>${schedule_label}</span></div>` : ''}
  ${hasFee ? `<div class="row"><b>Opłata wpisowa</b><span>${fmt(signup_fee)}</span></div>` : ''}
  <div class="row"><b>Karnet</b><span>${fmt(base_amount || total_amount)}</span></div>
  <div class="row total-row"><b>Zapłacono łącznie</b><span>${fmt(total_amount)}</span></div>
</div>
<div class="card" style="background:#fff;border:1.5px solid #e8e8e8">
  <div class="card-title">Adres zajęć</div>
  <p style="margin:0 0 12px;font-size:14px"><strong>${city}</strong>${location_address ? ' — ' + location_address : ''}</p>
  ${location_address ? `<a href="${mapsUrl}" class="btn btn-blue">📍 Otwórz w Google Maps</a>` : ''}
</div>
<div class="alert alert-ok">
  <strong>Potrzebujesz faktury?</strong> Napisz na <a href="mailto:biuro@akademiaobrony.pl">biuro@akademiaobrony.pl</a>
  z numerem ref. <strong>${payment_ref}</strong> i danymi firmy.
</div>
<p>Numer referencyjny: <span class="ref">${payment_ref}</span></p>
</div>${ftr()}</div></body></html>`,
  };
}

// ── MAIL 2: Dokument płatniczy / przelew ────────────────────────────────────
function mailPaymentDoc({ first_name, payment_ref, plan_name, group_name, city,
  total_amount, bank_account, bank_name, doc_url, online_url }) {

  return {
    subject: `Akademia Obrony Saggita — potwierdzenie rezerwacji (${payment_ref})`,
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Akademia Obrony Saggita</div><h1>Potwierdzenie rezerwacji</h1></div>
<div class="body">
<p class="hi">Cześć <strong>${first_name}</strong>!</p>
<p>Twoja rezerwacja w grupie <strong>${group_name}</strong> (${city}) została przyjęta. Czekamy na Twoją wpłatę.</p>
<div class="card">
  <div class="card-title">Co zapisano</div>
  <div class="row"><b>Karnet</b><span>${plan_name || '—'}</span></div>
  <div class="row"><b>Grupa</b><span>${group_name || '—'}</span></div>
  <div class="row"><b>Miasto</b><span>${city || '—'}</span></div>
  <div class="row total-row"><b>Kwota do wpłaty</b><span>${fmt(total_amount)}</span></div>
</div>
<div class="card">
  <div class="card-title">Dane do przelewu</div>
  <div class="row"><b>Numer konta</b><span style="font-family:monospace;font-size:13px">${bank_account}</span></div>
  <div class="row"><b>Odbiorca</b><span>${bank_name}</span></div>
  <div class="row"><b>Tytuł przelewu</b><span style="font-weight:700;color:#c42000">${payment_ref} — ${first_name}</span></div>
  <div class="row"><b>Kwota</b><span style="font-weight:700">${fmt(total_amount)}</span></div>
</div>
<div class="alert">
  <strong>⏱ Masz 3 dni robocze</strong> na dokonanie wpłaty. Po tym czasie rezerwacja przepada automatycznie.<br><br>
  Po przelewie wyślij potwierdzenie na: <a href="mailto:biuro@akademiaobrony.pl"><strong>biuro@akademiaobrony.pl</strong></a> — to przyspiesza weryfikację.
</div>
<div style="margin:20px 0">
  ${doc_url ? `<a href="${doc_url}" class="btn btn-outline">📄 Pobierz dokument płatniczy</a>` : ''}
  ${online_url ? `<a href="${online_url}" class="btn btn-red">💳 Zapłać online teraz</a>` : ''}
</div>
<p>Numer referencyjny: <span class="ref">${payment_ref}</span></p>
</div>${ftr()}</div></body></html>`,
  };
}

// ── MAIL 3: Wybrano płatność online ─────────────────────────────────────────
function mailPayOnlineChosen({ first_name, payment_ref, plan_name, group_name, city,
  total_amount, pay_url }) {

  return {
    subject: `Akademia Obrony Saggita — potwierdzenie rezerwacji (${payment_ref})`,
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Akademia Obrony Saggita</div><h1>Potwierdzenie rezerwacji — dokończ płatność</h1></div>
<div class="body">
<p class="hi">Cześć <strong>${first_name}</strong>!</p>
<p>Wybrałeś/aś płatność online za zapis do grupy <strong>${group_name}</strong> (${city}). Kliknij poniższy przycisk, żeby dokończyć — na wypadek, gdyby przekierowanie nie zadziałało.</p>
<div class="card">
  <div class="card-title">Twój zapis</div>
  <div class="row"><b>Karnet</b><span>${plan_name || '—'}</span></div>
  <div class="row"><b>Grupa</b><span>${group_name || '—'}</span></div>
  <div class="row"><b>Miasto</b><span>${city || '—'}</span></div>
  <div class="row total-row"><b>Do zapłaty</b><span>${fmt(total_amount)}</span></div>
</div>
${pay_url ? `<div style="margin:20px 0;text-align:center">
  <a href="${pay_url}" class="btn btn-red" style="font-size:16px;padding:16px 32px">💳 Zapłać ${fmt(total_amount)} online</a>
</div>` : ''}
<p>Numer referencyjny: <span class="ref">${payment_ref}</span></p>
<p style="color:#888;font-size:13px">Jeśli nie zamawiałeś/aś tego zapisu, zignoruj tę wiadomość lub skontaktuj się z nami.</p>
</div>${ftr()}</div></body></html>`,
  };
}

// ── MAIL 4: Admin — nowy zapis ───────────────────────────────────────────────
function mailAdmin({ first_name, last_name, email, phone, group_name, city,
  payment_ref, total_amount, plan_name, is_waitlist }) {
  return {
    subject: `Nowy zapis${is_waitlist ? ' (lista rez.)' : ''} — ${first_name} ${last_name}`,
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Akademia Obrony Saggita — Panel admina</div><h1>Nowy zapis${is_waitlist ? ' <span class="accent">(lista rez.)</span>' : ''}</h1></div>
<div class="body">
<div class="card">
  <div class="row"><b>Kursant</b><span>${first_name} ${last_name}</span></div>
  <div class="row"><b>Email</b><span>${email}</span></div>
  <div class="row"><b>Telefon</b><span>${phone}</span></div>
  <div class="row"><b>Karnet</b><span>${plan_name || '—'}</span></div>
  <div class="row"><b>Miasto / Grupa</b><span>${city} — ${group_name}</span></div>
  <div class="row"><b>Kwota</b><span>${fmt(total_amount)}</span></div>
  <div class="row"><b>Ref</b><span style="font-family:monospace">${payment_ref}</span></div>
</div>
</div>${ftr()}</div></body></html>`,
  };
}

// ── MAIL 5: Lista rezerwowa ───────────────────────────────────────────────────
function mailWaitlist({ first_name, payment_ref, group_name, city }) {
  return {
    subject: 'Akademia Obrony Saggita — potwierdzenie rezerwacji (lista rezerwowa)',
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Akademia Obrony Saggita</div><h1>Potwierdzenie rezerwacji — lista rezerwowa</h1></div>
<div class="body">
<p class="hi">Cześć <strong>${first_name}</strong>!</p>
<p>Twój zapis na <strong>listę rezerwową</strong> w grupie <strong>${group_name}</strong> (${city}) został przyjęty.</p>
<p>Skontaktujemy się, gdy pojawi się wolne miejsce.</p>
<p>Numer referencyjny: <span class="ref">${payment_ref}</span></p>
</div>${ftr()}</div></body></html>`,
  };
}

module.exports = {
  sendMail,
  mailPaymentConfirmed,
  mailPaymentDoc,
  mailPayOnlineChosen,
  mailAdmin,
  mailWaitlist,
  mailKursant: (d) => d.is_waitlist ? mailWaitlist(d) : mailPaymentDoc({ ...d, doc_url: '', online_url: '' }),
};
