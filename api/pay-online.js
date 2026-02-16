// api/pay-online.js
import { getPool } from "./_lib/db.js";
import { sendEmail, emailTemplateEnroll } from "./_lib/mailer.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { ref } = req.body || {};
    const paymentRef = (ref || "").toString().trim();
    if (!paymentRef) {
      res.status(400).json({ error: "Brak ref" });
      return;
    }

    const pool = getPool();

    const { rows } = await pool.query(
      `SELECT payment_ref, first_name, email, total_amount
         FROM registrations
        WHERE payment_ref = $1
        LIMIT 1`,
      [paymentRef]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Nie znaleziono zgłoszenia." });
      return;
    }

    const r = rows[0];

    // Placeholder: zaznacz akcję i np. status
    try {
      await pool.query(
        `UPDATE registrations
            SET last_action = 'pay_online',
                status = COALESCE(status,'enrolled')
          WHERE payment_ref = $1`,
        [paymentRef]
      );
    } catch (_) {}

    // Mail "Zapis potwierdzony"
    if (r.email) {
      await sendEmail({
        to: r.email,
        subject: "Zapis potwierdzony – Akademia Obrony Saggita",
        html: emailTemplateEnroll({
          firstName: r.first_name,
          ref: r.payment_ref,
          amount: r.total_amount ? Number(r.total_amount).toFixed(2) : null,
        }),
      });
    }

    // Tu później podepniemy bramkę – na razie tylko odpowiedź OK
    res.status(200).json({ ok: true, message: "Placeholder płatności online zapisany." });
  } catch (e) {
    res.status(500).json({ error: "Błąd płatności online (placeholder)." });
  }
}
