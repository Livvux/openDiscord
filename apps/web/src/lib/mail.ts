import nodemailer from "nodemailer";

const transport = process.env.SMTP_URL
  ? nodemailer.createTransport(process.env.SMTP_URL)
  : null;

/** True when an SMTP provider is configured; enables email verification. */
export const mailEnabled = transport !== null;

export async function sendMail(to: string, subject: string, text: string) {
  // Bot and webhook accounts use the reserved .invalid domain (RFC 2606): never mail them.
  if (/\.invalid$/i.test(to)) return;
  if (!transport) {
    // Self-hosted installs without SMTP: surface the message in the server log.
    console.info(`[mail disabled] to=${to} subject=${subject}\n${text}`);
    return;
  }
  await transport.sendMail({
    from: process.env.MAIL_FROM ?? "opendiscord <no-reply@localhost>",
    to,
    subject,
    text,
  });
}
