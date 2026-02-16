// /api/payment-document.js
import PDFDocument from "pdfkit";
import { getPool } from "./_lib/db.js";

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
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

function buildPdfBuffer({ reg, dueDate }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Styl prosty, czytelny
    doc.fontSize(18).text("DOKUMENT PŁATNICZY (PRO FORMA)", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#555").text("Wygenerowano automatycznie po rezerwacji miejsca.");
    doc.fillColor("#000");

    doc.moveDown(1);

    doc.fontSize(12).text("Organizator:", { continued: true }).fontSize(12).text(" Akademia Obrony Saggita");
    doc.fontSize(10).fillColor("#333").text("E-mail: biuro@akademiaobrony.pl  |  Tel.: 510 930 460");
    doc.fillColor("#000");

    doc.moveDown(1);

    doc.fontSize(12).text("Dane uczestnika:");
    doc.fontSize(11).text(`${reg.first_name || ""} ${reg.last_name || ""}`.trim() || "—");
    doc.fontSize(10).fillColor("#333").text(reg.email || "—");
    doc.fillColor("#000");

    doc.moveDown(1);

    const amount = reg.total_amount != null ? Number(reg.total_amount).toFixed(2) : "—";

    doc.fontSize(12).text("Szczegóły płatności:");
    doc.moveDown(0.3);
    doc.fontSize(11).text(`Kwota: ${amount} zł`);
    doc.fontSize(11).text(`Termin płatności: ${dueDate}`);
    doc.fontSize(11).text(`Kod zgłoszenia / tytuł przelewu: ${reg.transfer_title || reg.payment_ref}`);

    doc.moveDown(0.8);
    doc.fontSize(11).text(`Numer konta: ${reg.bank_account || "—"}`);
    doc.fontSize(11).text(`Odbiorca: ${reg.bank_name || "Akademia Obrony Saggita"}`);

    doc.moveDown(1);

    doc.fontSize(10).fillColor("#333").text(
      "Informacja: Rezerwacja jest ważna 3 dni robocze. Po tym czasie miejsce wraca do puli.",
      { align: "left" }
    );
    doc.fillColor("#000");

    doc.moveDown(2);
    doc.fontSize(9).fillColor("#888").text(
      "To nie jest faktura VAT. Dokument ma charakter informacyjny/pro forma.",
      { align: "left" }
    );

    doc.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const payment_ref = req.query?.payment_ref;
    if (!payment_ref || typeof payment_ref !== "string") {
      return res.status(400).json({ error: "Brak payment_ref." });
    }

    const pool = getPool();

    const r1 = await pool.query(
      `SELECT
         payment_ref, first_name, last_name, email,
         total_amount, bank_account, bank_name, transfer_title
       FROM registrations
       WHERE payment_ref = $1
       LIMIT 1`,
      [payment_ref]
    );

    if (!r1.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono zapisu o takim kodzie." });
    }

    const reg = r1.rows[0];
    const dueDate = formatPL(addBusinessDays(new Date(), 3));

    const pdf = await buildPdfBuffer({ reg, dueDate });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="dokument-platniczy-${payment_ref}.pdf"`);
    res.status(200).send(pdf);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Błąd serwera." });
  }
}
