// api/_lib/mailer.js
import nodemailer from "nodemailer";

export function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("Brak konfiguracji SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS).");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export async function sendEmail({ to, subject, html }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const transporter = getTransport();

  await transporter.sendMail({
    from,
    to,
    subject,
    html,
  });
}

export function emailTemplateEnroll({ firstName, ref, amount }) {
  return `
  <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
    <h2 style="margin:0 0 10px;">Zapis potwierdzony ✅</h2>
    <p>Cześć ${escapeHtml(firstName || "")},</p>
    <p>Twoje zgłoszenie zostało przyjęte i zapis jest potwierdzony.</p>
    <p><strong>Kod:</strong> ${escapeHtml(ref || "")}</p>
    ${amount ? `<p><strong>Kwota:</strong> ${escapeHtml(String(amount))} zł</p>` : ""}
    <p style="margin-top:18px;">W razie pytań: <strong>biuro@akademiaobrony.pl</strong> · <strong>510 930 460</strong></p>
  </div>`;
}

export function emailTemplateReservation({ firstName, ref }) {
  return `
  <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
    <h2 style="margin:0 0 10px;">Rezerwacja przyjęta 🧾</h2>
    <p>Cześć ${escapeHtml(firstName || "")},</p>
    <p>Twoje miejsce zostało zarezerwowane. Na opłatę masz <strong>3 dni robocze</strong>.</p>
    <p>Po tym czasie rezerwacja przepada.</p>
    <p><strong>Kod rezerwacji:</strong> ${escapeHtml(ref || "")}</p>
    <p style="margin-top:18px;">W razie pytań: <strong>biuro@akademiaobrony.pl</strong> · <strong>510 930 460</strong></p>
  </div>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
