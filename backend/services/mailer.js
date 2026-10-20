/**
 * services/mailer.js — sends e-mail through Gmail SMTP.
 *
 * .env:
 *   MAIL_USER=presence.pro26@gmail.com
 *   MAIL_PASS=<16-character Google App Password>   (NOT the normal Gmail password)
 *   MAIL_FROM_NAME=PresencePro                      (optional)
 *
 * Needs:  npm i nodemailer
 *
 * Without MAIL_PASS (local development only) the message is printed to the server console instead of sent.
 * In production (NODE_ENV=production) a missing password is an error, so codes are never silently lost.
 */
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.MAIL_USER || "presence.pro26@gmail.com", pass: process.env.MAIL_PASS },
    pool: true,
    maxConnections: 3,
  });
  return transporter;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#F5F6FA;font-family:Arial,Helvetica,sans-serif;color:#0F172A">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;border:1px solid #E5E8F0">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:800;color:#4834D4">PresencePro</td></tr>
<tr><td style="padding:8px 32px 0;font-size:18px;font-weight:700">${esc(title)}</td></tr>
<tr><td style="padding:12px 32px 28px;font-size:14px;line-height:22px;color:#475569">${bodyHtml}</td></tr>
</table>
<p style="font-size:12px;color:#94A3B8;margin-top:16px">This is an automated message. Please do not reply.</p>
</td></tr></table></body></html>`;
}

async function sendMail({ to, subject, text, html }) {
  if (!process.env.MAIL_PASS) {
    if (process.env.NODE_ENV === "production") throw new Error("Mail is not configured (MAIL_PASS missing)");
    console.log(`\n[mailer:DEV] to=${to}\nsubject=${subject}\n${text}\n`);
    return;
  }
  const name = process.env.MAIL_FROM_NAME || "PresencePro";
  await getTransporter().sendMail({
    from: `"${name}" <${process.env.MAIL_USER || "presence.pro26@gmail.com"}>`,
    to,
    subject,
    text,
    html,
  });
}

function sendOtpMail(to, code, purpose, ttlMin) {
  const what = purpose === "reset" ? "reset your password" : "verify your email address";
  const title = purpose === "reset" ? "Password reset code" : "Verify your email";
  const html = layout(
    title,
    `<p>Use this code to ${what}. It expires in ${ttlMin} minutes.</p>
     <p style="font-size:34px;font-weight:800;letter-spacing:10px;color:#0F172A;background:#EEF0FF;border-radius:12px;padding:14px 0;text-align:center;margin:18px 0">${esc(code)}</p>
     <p>Never share this code with anyone. PresencePro staff will never ask for it.<br>If you did not request it, you can ignore this email.</p>`
  );
  return sendMail({
    to,
    subject: `${code} is your PresencePro ${purpose === "reset" ? "password reset" : "verification"} code`,
    text: `Your PresencePro code is ${code}. It expires in ${ttlMin} minutes. Never share it with anyone. If you did not request it, ignore this email.`,
    html,
  });
}

function sendPasswordChangedMail(to) {
  return sendMail({
    to,
    subject: "Your PresencePro password was changed",
    text: "Your PresencePro password was just changed. If this was not you, reset it again immediately and contact your institute.",
    html: layout("Password changed", `<p>Your password was just changed and all other devices were signed out.</p><p>If this was not you, reset it again immediately and contact your institute.</p>`),
  });
}

module.exports = { sendMail, sendOtpMail, sendPasswordChangedMail };