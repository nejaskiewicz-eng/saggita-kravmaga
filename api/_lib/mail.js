// api/_lib/mail.js — CommonJS
// Wysyłka przez Resend API (fetch natywny Node 18+)

const SITE_URL = process.env.SITE_URL || 'https://akademiaobrony.pl';

async function sendMail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f5f5f7;color:#1d1d1f;line-height:1.5}
.wrap{max-width:600px;margin:40px auto;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06)}
.hdr{background:#111111;padding:36px 40px;text-align:center}
.hdr .brand{color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:8px}
.hdr h1{color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.01em}
.accent{color:#ff3b30}
.body{padding:40px}
.hi{font-size:18px;font-weight:600;margin-bottom:24px;color:#1d1d1f}
.card{background:#f5f5f7;border-radius:12px;padding:24px;margin:24px 0}
.card-title{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#86868b;margin-bottom:16px}
.row{display:table;width:100%;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:15px}
.row:last-child{border-bottom:none}
.row b{display:table-cell;vertical-align:middle;color:#1d1d1f;font-weight:600;width:40%;text-align:left}
.row span{display:table-cell;vertical-align:middle;color:#515154;text-align:right;width:60%}
.total-row{padding-top:16px;margin-top:8px;border-top:2px solid rgba(0,0,0,0.08)}
.total-row b{font-size:17px;color:#1d1d1f}
.total-row span{font-size:19px;font-weight:800;color:#ff3b30}
.ref{display:inline-block;background:#e5e5ea;border-radius:6px;padding:6px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;font-weight:700;letter-spacing:0.05em;color:#1d1d1f;margin:8px 0}
.btn{display:inline-block;padding:16px 28px;border-radius:12px;font-weight:600;font-size:15px;text-decoration:none;margin:12px 0;color:#fff;text-align:center;transition:transform 0.2s}
.btn-red{background:#ff3b30;box-shadow:0 4px 12px rgba(255,59,48,0.3)}
.btn-blue{background:#0071e3}
.btn-outline{background:#fff;color:#1d1d1f;border:1px solid #d2d2d7;box-shadow:0 2px 8px rgba(0,0,0,0.04)}
.alert{background:#fdf5e6;border:1px solid #fce8cd;border-left:4px solid #f5a623;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:14px;color:#4a3b22}
.alert strong{color:#b67400}
.alert-ok{background:#f2fbf5;border-color:#e4f7eb;border-left-color:#34c759;color:#1c432b}
.alert-ok strong{color:#248a3d}
p{font-size:15px;margin:12px 0;color:#515154}
.schedule-row{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#ffffff;border:1px solid #e5e5ea;border-radius:10px;margin-bottom:8px}
.pill{background:#e5e5ea;color:#1d1d1f;padding:4px 10px;border-radius:16px;font-size:12px;font-weight:600}
.ftr{padding:24px 40px;background:#f5f5f7;font-size:12px;color:#86868b;text-align:center}
.ftr a{color:#86868b;text-decoration:none;opacity:0.8}
@media (max-width: 600px){
  .wrap{margin:16px;border-radius:12px}
  .hdr{padding:28px 20px}
  .body{padding:24px 20px}
  .ftr{padding:20px}
}
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
  const hasFee = parseFloat(signup_fee || 0) > 0;

  return {
    subject: '✅ Akademia Obrony Saggita — potwierdzenie rezerwacji',
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Krav Maga Saggita</div><h1>Potwierdzenie rezerwacji</h1></div>
<div class="body">
<p class="hi">Cześć ${first_name}! 🥊</p>
<p>Twoja płatność została zaksięgowana. Jesteś oficjalnie zapisany/a na zajęcia. Do zobaczenia na sali treningowej!</p>
<div class="card">
  <div class="card-title">Szczegóły zapisu</div>
  <div class="row"><b>Karnet</b><span class="pill">${plan_name || '—'}</span></div>
  <div class="row"><b>Grupa</b><span>${group_name || '—'}</span></div>
  <div class="row"><b>Miasto</b><span>${city || '—'}</span></div>
  ${schedule_label ? `<div class="row"><b>Termin</b><span>${schedule_label}</span></div>` : ''}
  ${hasFee ? `<div class="row"><b>Karnet podstawowy</b><span>${fmt(base_amount || total_amount)}</span></div><div class="row"><b>Opłata wpisowa</b><span>${fmt(signup_fee)}</span></div>` : ''}
  <div class="row total-row"><b>Zapłacono łącznie</b><span>${fmt(total_amount)}</span></div>
</div>
<div class="card" style="background:#ffffff;border:1px solid #e5e5ea;box-shadow:0 2px 12px rgba(0,0,0,0.03)">
  <div class="card-title" style="color:#1d1d1f">Adres zajęć</div>
  <p style="margin:0 0 16px;font-size:15px;color:#1d1d1f"><strong>${city}</strong>${location_address ? ' — ' + location_address : ''}</p>
  ${location_address ? `<a href="${mapsUrl}" class="btn btn-blue" style="width:100%;margin:0;padding:14px">📍 Otwórz w Google Maps</a>` : ''}
</div>
<div class="alert alert-ok">
  <strong>Potrzebujesz faktury?</strong> Napisz bezpośrednio na <a href="mailto:biuro@akademiaobrony.pl" style="color:#248a3d">biuro@akademiaobrony.pl</a> podając numer ref. <strong>${payment_ref}</strong> oraz dane swojej firmy.
</div>
<div style="text-align:center;margin-top:32px">
  <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-bottom:4px">Numer referencyjny</p>
  <span class="ref">${payment_ref}</span>
</div>
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
<div class="hdr"><div class="brand">Krav Maga Saggita</div><h1>Potwierdzenie rezerwacji</h1></div>
<div class="body">
<p class="hi">Cześć ${first_name}!</p>
<p>Właśnie zapłacowaliśmy Twoje miejsce w grupie <strong>${group_name}</strong> w mieście ${city}. Aby sfinalizować zapis, opłać karnet zgodnie z poniższymi instrukcjami.</p>
<div class="card">
  <div class="card-title">Szczegóły zapisu</div>
  <div class="row"><b>Karnet</b><span class="pill">${plan_name || '—'}</span></div>
  <div class="row"><b>Grupa</b><span>${group_name || '—'}</span></div>
  <div class="row"><b>Miasto</b><span>${city || '—'}</span></div>
  <div class="row total-row"><b>Kwota do wpłaty</b><span>${fmt(total_amount)}</span></div>
</div>
<div class="card" style="background:#ffffff;border:1px solid #0071e3;box-shadow:0 4px 16px rgba(0,113,227,0.1)">
  <div class="card-title" style="color:#0071e3">Dane do przelewu tradycyjnego</div>
  <div class="row"><b>Numer konta</b><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0.05em">${bank_account}</span></div>
  <div class="row"><b>Odbiorca</b><span>${bank_name}</span></div>
  <div class="row" style="background:rgba(255,59,48,0.05);padding:12px;border-radius:8px;margin-top:8px">
    <b>Tytuł przelewu</b><span style="font-weight:800;color:#ff3b30">${payment_ref} — ${first_name}</span>
  </div>
</div>
<div class="alert">
  <strong>⏱ Masz 3 dni robocze</strong> na dokonanie wpłaty. Po tym czasie nieopłacona rezerwacja wejściówki może przepaść.<br><br>
  Aby przyspieszyć weryfikację (jeśli trening masz jutro), możesz wysłać wygenerowane potwierdzenie z banku na adres <a href="mailto:biuro@akademiaobrony.pl" style="color:#b67400">biuro@akademiaobrony.pl</a>.
</div>
<div style="margin:32px 0;display:flex;flex-direction:column;gap:12px">
  ${online_url ? `<a href="${online_url}" class="btn btn-red" style="margin:0">💳 Zapłać natychmiastowo online</a>` : ''}
  ${doc_url ? `<a href="${doc_url}" class="btn btn-outline" style="margin:0">📄 Pobierz druk zapłaty (PDF)</a>` : ''}
</div>
<div style="text-align:center">
  <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-bottom:4px">Numer referencyjny</p>
  <span class="ref">${payment_ref}</span>
</div>
</div>${ftr()}</div></body></html>`,
  };
}

// ── MAIL 3: Wybrano płatność online ─────────────────────────────────────────
function mailPayOnlineChosen({ first_name, payment_ref, plan_name, group_name, city,
  total_amount, pay_url }) {

  return {
    subject: `Opłać swoją rezerwację — Akademia Obrony Saggita (${payment_ref})`,
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Krav Maga Saggita</div><h1>Dokończ płatność online</h1></div>
<div class="body">
<p class="hi">Cześć ${first_name}!</p>
<p>Twoje dane zapisu do grupy <strong>${group_name}</strong> (${city}) zostały pomyślnie przetworzone. Pozostał tylko ostatni krok — finalizacja transakcji online.</p>
<div class="card">
  <div class="card-title">Twój zapis</div>
  <div class="row"><b>Karnet</b><span class="pill">${plan_name || '—'}</span></div>
  <div class="row"><b>Ośrodek</b><span>${city} / ${group_name}</span></div>
  <div class="row total-row"><b>Do zapłaty</b><span>${fmt(total_amount)}</span></div>
</div>
${pay_url ? `<div style="margin:32px 0;text-align:center">
  <a href="${pay_url}" class="btn btn-red" style="display:block;font-size:16px;padding:20px;width:100%;margin:0">💳 Przejdź do bezpiecznej wpłaty ${fmt(total_amount)}</a>
</div>` : ''}
<div style="text-align:center;margin-top:32px">
  <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-bottom:4px">Numer referencyjny</p>
  <span class="ref">${payment_ref}</span>
</div>
<p style="text-align:center;color:#86868b;font-size:13px;margin-top:24px">Zignoruj tę wiadomość, jeśli transakcja została już ukończona w oknie przeglądarki.</p>
</div>${ftr()}</div></body></html>`,
  };
}


// ── MAIL 2b: Płatność miesięczna — harmonogram wpłat ────────────────────────
function mailMonthlySchedule({ first_name, payment_ref, plan_name, group_name, city,
  total_amount, bank_account, bank_name, months, monthly_rate, signup_fee, reminders }) {

  const fee = parseFloat(signup_fee || 0);
  const rate = parseFloat(monthly_rate || 0);
  const firstAmt = rate + fee;

  // Generuj wiersze harmonogramu z datami (ostatni dzień miesiąca poprzedzającego)
  const now = new Date();
  const day = now.getDate();
  const startOffset = day > 15 ? 1 : 0;
  let rows = '';
  for (let i = 0; i < months; i++) {
    const mo = startOffset + i;
    const d = new Date(now.getFullYear(), now.getMonth() + mo, 1);
    const label = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
    const amt = i === 0 ? firstAmt : rate;
    let deadline;
    if (i === 0 && startOffset === 0) {
      deadline = 'Teraz (w 3 dni)';
    } else {
      const prevEnd = new Date(now.getFullYear(), now.getMonth() + mo, 0);
      deadline = 'do ' + prevEnd.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    rows += `<div style="padding:12px 16px;background:#ffffff;border:1px solid #e5e5ea;border-radius:10px;margin-bottom:8px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr>
          <td width="30" valign="top" style="color:#86868b;font-weight:600;font-variant-numeric:tabular-nums;padding-top:2px">${i + 1}.</td>
          <td valign="top">
            <strong style="display:block;font-size:15px;color:#1d1d1f;text-transform:capitalize">${label}</strong>
            <span style="display:block;font-size:13px;color:#ff3b30;font-weight:600">${deadline}</span>
          </td>
          <td align="right" valign="top" style="font-weight:700;font-size:16px;color:#1d1d1f;padding-top:2px">${fmt(amt)}</td>
        </tr>
      </table>
    </div>`;
  }

  return {
    subject: `Rezerwacja i plan płatności — Akademia Obrony Saggita (${payment_ref})`,
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Krav Maga Saggita</div><h1>Potwierdzenie rezerwacji</h1></div>
<div class="body">
<p class="hi">Cześć ${first_name}!</p>
<p>Dziękujemy za wybranie opcji subskrypcji miesięcznej na zajęcia w <strong>${city}</strong>. Poniżej znajduje się Twój spersonalizowany plan płatności.</p>
<div class="card">
  <div class="card-title">Co zapisano</div>
  <div class="row"><b>Karnet (Miesięczny)</b><span class="pill">${plan_name || '—'}</span></div>
  <div class="row"><b>Grupa</b><span>${group_name || '—'}</span></div>
  <div class="row total-row"><b>Suma początkowa</b><span>${fmt(firstAmt)}${fee > 0 ? ` <br><span style="font-size:12px;color:#86868b;font-weight:500">(${fmt(rate)} opłata mies. + ${fmt(fee)} wpisowe)</span>` : ''}</span></div>
</div>
<h3 style="margin:32px 0 16px;font-size:16px;font-weight:700;color:#1d1d1f">📅 Podsumowanie opłat miesięcznych (${months} m-cy)</h3>
<div style="margin-bottom:8px">
  ${rows}
</div>
<p style="font-size:13px;color:#86868b;text-align:right;margin-top:8px">Łączna wartość umowy: <strong>${fmt(total_amount)} zł</strong></p>

<div class="card" style="background:#ffffff;border:1px solid #0071e3;box-shadow:0 4px 16px rgba(0,113,227,0.1)">
  <div class="card-title" style="color:#0071e3">Twoje konto do wpłat (Pierwsza wpłata)</div>
  <div class="row"><b>Numer konta</b><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0.05em">${bank_account}</span></div>
  <div class="row"><b>Odbiorca</b><span>${bank_name}</span></div>
  <div class="row" style="background:rgba(255,59,48,0.05);padding:12px;border-radius:8px;margin-top:8px">
    <b style="width:30%">Tytuł przelewu</b><span style="font-weight:800;color:#ff3b30;width:70%">${payment_ref} — ${first_name}</span>
  </div>
</div>
<div class="alert">
  <strong>Prosimy o uregulowanie opłaty za 1. miesiąc (${fmt(firstAmt)}) w ciągu 3 dni</strong> roboczych na wskazane konto bankowe by potwierdzić zapis.
</div>
${reminders ? '<p style="font-size:14px;color:#515154;text-align:center;margin-top:24px"><span style="color:#34c759">✓</span> <strong>Automatyczne przypomnienia włączone</strong>. Przed każdym terminem otrzymasz od nas krótką wiadomość email.</p>' : ''}
<div style="text-align:center;margin-top:32px">
  <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-bottom:4px">Klucz rozliczeniowy</p>
  <span class="ref">${payment_ref}</span>
</div>
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
<div class="hdr"><div class="brand">Admin Saggita</div><h1>Nowy zapis${is_waitlist ? ' <span class="accent">(Rezerwowy)</span>' : ''}</h1></div>
<div class="body">
<div class="card">
  <div class="row"><b>Kursant</b><span>${first_name} ${last_name}</span></div>
  <div class="row"><b>Email</b><span>${email}</span></div>
  <div class="row"><b>Telefon</b><span>${phone}</span></div>
  <div class="row"><b>Karnet</b><span class="pill">${plan_name || '—'}</span></div>
  <div class="row"><b>Miasto / Grupa</b><span>${city} — ${group_name}</span></div>
  <div class="row total-row"><b>Wartość</b><span>${fmt(total_amount)}</span></div>
</div>
<div style="text-align:center;margin-top:24px">
  <span class="ref">${payment_ref}</span>
</div>
</div>${ftr()}</div></body></html>`,
  };
}

// ── MAIL 5: Lista rezerwowa ───────────────────────────────────────────────────
function mailWaitlist({ first_name, payment_ref, group_name, city }) {
  return {
    subject: 'Lista rezerwowa Krav Maga Saggita — Potwierdzenie przyjęcia',
    html: `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">${baseStyle()}</head><body>
<div class="wrap">
<div class="hdr"><div class="brand">Krav Maga Saggita</div><h1>Lista rezerwowa</h1></div>
<div class="body">
<p class="hi">Cześć ${first_name}!</p>
<p>Twój zapis na <strong>listę rezerwową</strong> w grupie <strong>${group_name}</strong> pod adresem <strong>${city}</strong> został z powodzeniem przyjęty.</p>
<div class="alert alert-ok" style="text-align:center">
  Jeśli w grupie zwolni się miejsce lub otworzymy dodatkową pulę, <strong>poinformujemy Cię o tym mailowo lub telefonicznie</strong> najszybciej jak to możliwe!
</div>
<div style="text-align:center;margin-top:32px">
  <span class="ref">${payment_ref}</span>
</div>
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
  mailKursant: (d) => d.is_waitlist ? mailWaitlist(d) : (d.payment_mode === 'monthly' ? mailMonthlySchedule(d) : mailPaymentDoc({ ...d, doc_url: '', online_url: '' })),
};
