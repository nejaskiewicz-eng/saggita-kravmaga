// api/payment-document.js
import PDFDocument from "pdfkit";
import { getPool } from "./_lib/db.js";
import { sendEmail, emailTemplateReservation } from "./_lib/mailer.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const ref = (req.query.ref || "").toString().trim();
    if (!ref) {
      res.status(400).json({ error: "Brak parametru ref" });
      return;
    }

    const pool = getPool();

    // UWAGA: zakładam tabelę registrations z kolumnami:
    // payment_ref, first_name, email, total_amount, bank_account, bank_name, transfer_title
    // Jeśli masz inne nazwy – powiedz, to dopasuję 1:1 do Twojego schematu.
    const { rows } = await pool.query(
      `SELECT payment_ref, first_name, last_name, email,
              total_amount, bank_account, bank_name, transfer_title
         FROM registrations
        WHERE payment_ref = $1
        LIMIT 1`,
      [ref]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Nie znaleziono zgłoszenia dla tego kodu." });
      return;
    }

    const r = rows[0];

    // Zapisz, że pobrano dokument / ustaw status rezerwacji
    // (jeśli nie masz tych kolumn, usuń tę sekcję – albo dopasuję pod Twoją bazę)
    try {
      await pool.query(
        `UPDATE registrations
            SET status = COALESCE(status,'reserved'),
                reserved_until = COALESCE(reserved_until, NOW() + INTERVAL '3 business days'),
                last_action = 'payment_document'
          WHERE payment_ref = $1`,
        [ref]
      );
    } catch (_) {
      // jeśli nie masz takich kolumn – nie wywalamy endpointu
    }

    // Wyślij mail rezerwacji (3 dni robocze)
    if (r.email) {
      await sendEmail({
        to: r.email,
        subject: "Rezerwacja miejsca – masz 3 dni robocze na opłatę",
        html: emailTemplateReservation({ firstName: r.first_name, ref: r.payment_ref }),
      });
    }

    // PDF
    const doc = new PDFDocument({ size: "A4", margin: 48 });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="dokument-platniczy-${ref}.pdf"`);
      res.status(200).send(pdfBuffer);
    });

    // Treść PDF
    doc.fontSize(18).text("Dokument płatniczy", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#666").text("Akademia Obrony Saggita", { align: "left" });
    doc.moveDown(1.2);
    doc.fillColor("#000");

    doc.fontSize(12).text(`Kod: ${r.payment_ref}`);
    doc.moveDown(0.6);

    const amount = r.total_amount ? Number(r.total_amount).toFixed(2) : "—";
    doc.text(`Kwota do wpłaty: ${amount} zł`);
    doc.moveDown(0.4);

    if (r.bank_account) doc.text(`Numer konta: ${r.bank_account}`);
    if (r.bank_name) doc.text(`Odbiorca: ${r.bank_name}`);
    if (r.transfer_title) doc.text(`Tytuł przelewu: ${r.transfer_title}`);

    doc.moveDown(1.2);
    doc.fillColor("#444").fontSize(10).text(
      "Rezerwacja jest ważna 3 dni robocze. Po tym czasie przepada, jeśli płatność nie wpłynie."
    );

    doc.end();
  } catch (e) {
    res.status(500).json({ error: "Błąd generowania dokumentu." });
  }
}
