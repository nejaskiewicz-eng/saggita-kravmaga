// /api/_lib/mail.js
import { Resend } from "resend";

export function getResend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Brak RESEND_API_KEY w zmiennych środowiskowych na Vercel.");
  }
  return new Resend(process.env.RESEND_API_KEY);
}

export function getMailFrom() {
  // na start testowo: onboarding@resend.dev
  return process.env.MAIL_FROM || "onboarding@resend.dev";
}

export function asTextEmail({ subject, lines }) {
  return {
    subject,
    text: lines.filter(Boolean).join("\n"),
  };
}
