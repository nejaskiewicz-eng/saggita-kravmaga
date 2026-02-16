// /api/registration/action.js
import { getPool } from "../_lib/db.js";
import { getResend, getMailFrom, asTextEmail } from "../_lib/mail.js";

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 0=nd, 6=sob
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

function formatPL(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { payment_ref, action } = req.body || {};
    if (!payment_ref || typeof payment_ref !== "string") {
      return res.status(400).json({ error: "Brak payment_ref." });
    }
    if (!["pay_online", "download_doc"].includes(action)) {
      return res.status(400).json({ error: "Nieprawidłowa akcja." });
    }

    const pool = getPool();

    // 1) Pobierz zapis po payment_ref
    // Uwaga: zakładam tabelę "registrations" z kolumną payment_ref
    const r1 = await pool.query(
      `SELECT
         id, payment_ref, first_name, last_name, email,
         total_amount, bank_account, bank_name, transfer_title,
         is_waitlist, created_at
       FROM registrations
       WHERE payment_ref = $1
       LIMIT 1`,
      [payment_ref]
    );

    if (!r1.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono zapisu o takim kodzie." });
    }

    const reg = r1.rows[0];

    // 2) Zapisz akcję w bazie (żeby było wiadomo co wybrał kursant)
    await pool.query(
      `UPDATE registrations
       SET action = $2, action_at = NOW()
       WHERE payment_ref = $1`,
      [payment_ref, action]
    );

    // 3) Wyślij maila zależnie od akcji
    const resend = getResend();
    const from = getMailFrom();

    const fullName = `${reg.first_name || ""} ${reg.last_name || ""}`.trim();
    const amount = reg.total_amount != null ? Number(reg.total_amount).toFixed(2) : null;

    const dueDate = formatPL(addBusinessDays(new Date(), 3));

    if (!reg.email) {
      return res.status(400).json({ error: "Brak email w zapisie – nie mogę wysłać potwierdzenia." });
    }

    if (action === "pay_online") {
      // Potwierdzenie zapisu na szkolenie
      const mail = asTextEmail({
        subject: "Potwierdzenie zapisu — Krav Maga Saggita",
        lines: [
          `Cześć ${reg.first_name || ""},`,
          "",
          "Dziękujemy — Twój zapis został przyjęty.",
          "",
          `Kod zgłoszenia: ${reg.payment_ref}`,
          fullName ? `Uczestnik: ${fullName}` : null,
          amount ? `Kwota: ${amount} zł` : null,
          "",
          "Płatność online jest w trakcie podpinania (na razie przycisk jest placeholderem).",
          "Jeśli chcesz zapłacić przelewem, użyj danych z potwierdzenia na stronie.",
          "",
          "W razie pytań:",
          "biuro@akademiaobrony.pl · 510 930 460",
        ],
      });

      await resend.emails.send({
        from,
        to: reg.email,
        subject: mail.subject,
        text: mail.text,
      });

      return res.status(200).json({ ok: true });
    }

    // action === "download_doc"
    // Potwierdzenie rezerwacji + informacja o 3 dniach roboczych
    const mail = asTextEmail({
      subject: "Rezerwacja miejsca — oczekujemy na wpłatę (3 dni robocze)",
      lines: [
        `Cześć ${reg.first_name || ""},`,
        "",
        "Twoja rezerwacja miejsca została przyjęta.",
        "",
        `Kod zgłoszenia: ${reg.payment_ref}`,
        fullName ? `Uczestnik: ${fullName}` : null,
        amount ? `Kwota: ${amount} zł` : null,
        "",
        `Na opłatę masz 3 dni robocze (do ${dueDate}).`,
        "Po tym czasie rezerwacja przepada.",
        "",
        "Dokument płatniczy możesz pobrać ze strony (przycisk „Pobierz dokument płatniczy”).",
        "",
        "W razie pytań:",
        "biuro@akademiaobrony.pl · 510 930 460",
      ],
    });

    await resend.emails.send({
      from,
      to: reg.email,
      subject: mail.subject,
      text: mail.text,
    });

    return res.status(200).json({ ok: true, due_date: dueDate });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Błąd serwera." });
  }
}
