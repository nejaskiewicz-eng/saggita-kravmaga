// api/_lib/mail.js — CommonJS
// Wysyłka przez Resend API (fetch natywny Node 18+)

async function sendMail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Krav Maga Saggita <biuro@akademiaobrony.pl>';

  if (!key) {
    console.warn('[mail] Brak RESEND_API_KEY — mail nie zostanie wysłany');
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[mail] Resend error:', res.status, txt);
    }
  } catch (e) {
    console.error('[mail] Fetch error:', e.message);
  }
}

// Szablon: potwierdzenie zapisu dla kursanta
function mailKursant({ first_name, payment_ref, group_name, city, total_amount, bank_account, bank_name, is_waitlist }) {
  if (is_waitlist) {
    return {
      subject: 'Lista rezerwowa — Krav Maga Saggita',
      html: `<p>Cześć ${first_name}!</p>
<p>Twój zapis na <strong>listę rezerwową</strong> w grupie <strong>${group_name}</strong> (${city}) został przyjęty.</p>
<p>Skontaktujemy się, gdy pojawi się wolne miejsce.</p>
<p>Kod referencyjna: <strong>${payment_ref}</strong></p>
<br><p>Akademia Obrony Saggita<br>biuro@akademiaobrony.pl | 510 930 460</p>`,
    };
  }
  return {
    subject: 'Potwierdzenie zapisu — Krav Maga Saggita',
    html: `<p>Cześć ${first_name}!</p>
<p>Twój zapis do grupy <strong>${group_name}</strong> (${city}) został przyjęty.</p>
<p><strong>Kwota do wpłaty:</strong> ${parseFloat(total_amount || 0).toFixed(2)} zł</p>
<p><strong>Numer konta:</strong> ${bank_account || 'do potwierdzenia'}</p>
<p><strong>Odbiorca:</strong> ${bank_name || 'Akademia Obrony Saggita'}</p>
<p><strong>Tytuł przelewu:</strong> ${payment_ref}</p>
<p>Masz <strong>3 dni robocze</strong> na dokonanie wpłaty — po tym czasie rezerwacja przepada.</p>
<br><p>Akademia Obrony Saggita<br>biuro@akademiaobrony.pl | 510 930 460</p>`,
  };
}

// Szablon: powiadomienie dla admina
function mailAdmin({ first_name, last_name, email, phone, group_name, city, payment_ref, total_amount, is_waitlist }) {
  return {
    subject: `Nowy zapis${is_waitlist ? ' (lista rez.)' : ''} — ${first_name} ${last_name}`,
    html: `<p><strong>Nowy zapis${is_waitlist ? ' na listę rezerwową' : ''}!</strong></p>
<p>Kursant: <strong>${first_name} ${last_name}</strong><br>
Email: ${email}<br>Telefon: ${phone}<br>
Miasto: ${city}<br>Grupa: ${group_name}<br>
Kwota: ${parseFloat(total_amount || 0).toFixed(2)} zł<br>
Ref: <strong>${payment_ref}</strong></p>`,
  };
}

module.exports = { sendMail, mailKursant, mailAdmin };
