"use strict";

/**
 * SMTP email service for OneOps (cPanel mailboxes).
 *
 * - nodemailer 6.9.x — Node 14 compatible, pinned.
 * - Supports cPanel Option A (465/SSL, SMTP_SECURE=true) and
 *   Option B (587/STARTTLS, SMTP_SECURE=false). TLS verification is NEVER
 *   disabled; connection errors are surfaced, not bypassed.
 * - Credentials live only in env config; never returned by any API and
 *   never logged. Transporter keeps a single connection pool.
 * - Test hooks: NODE_ENV=test or EMAIL_TRANSPORT=mock swaps the transport
 *   for an in-memory capture so automated tests never send real mail.
 */

const nodemailer = require("nodemailer");
const { config } = require("./config");

// --- structured logging (§7) --------------------------------------------------
// Every SMTP diagnostic line carries the [SMTP] prefix + ISO timestamp.
// NEVER log: passwords, auth payloads, invitation/reset tokens, full bodies.

function smtpLog(message) {
  console.log(`[SMTP] ${new Date().toISOString()} ${message}`);
}

function smtpError(message, err) {
  const code = err && err.code ? ` code=${err.code}` : "";
  const clean = String((err && err.message) || "").replace(/[\r\n]+/g, " ");
  console.error(`[SMTP] ${new Date().toISOString()} ${message}${code} ${clean}`);
}

/** True when verbose SMTP wire logging is enabled (SMTP_DEBUG=true). */
const debugEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.SMTP_DEBUG || "").toLowerCase()
);

// --- state -------------------------------------------------------------------
let transporter = null;
let transporterError = null;

/** Captured messages when running under the mock transport (tests only). */
const mockOutbox = [];

function smtpConfigured() {
  if (config.smtp.mockTransport) return true; // mock transport needs no SMTP env
  return Boolean(
    config.smtp.host && config.smtp.port && config.smtp.user && config.smtp.password
  );
}

function baseUrl() {
  return (config.smtp.baseUrl || "http://localhost:5173").replace(/\/+$/, "");
}

function getTransporter() {
  // Mock transport first: tests run WITHOUT any SMTP configuration.
  if (config.smtp.mockTransport) {
    if (transporter && transporter._mock) return transporter;
    transporter = {
      _mock: true,
      async sendMail(mail) {
        mockOutbox.push({
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          accepted: [mail.to],
        });
        return { accepted: [mail.to], rejected: [], response: "250 mock" };
      },
      async verify() {
        return true;
      },
    };
    transporterError = null;
    return transporter;
  }

  if (!smtpConfigured()) {
    const err = new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD (and optionally SMTP_FROM_NAME, SMTP_FROM_EMAIL, APP_BASE_URL)."
    );
    err.status = 503;
    err.code = "SMTP_NOT_CONFIGURED";
    throw err;
  }

  if (transporter) return transporter;
  if (transporterError) throw transporterError;

  try {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // 465 → implicit TLS; 587/25 → STARTTLS upgrade (never false to bypass).
      secure: Boolean(config.smtp.secure),
      auth: { user: config.smtp.user, pass: config.smtp.password },
      // Deterministic failures over silent hangs on shared hosting.
      connectionTimeout: 15000,
      greetingTimeout: 12000,
      socketTimeout: 20000,
      // Sender identity helps cPanel relays accept the message.
      name: config.smtp.baseUrl ? new URL(baseUrl()).hostname : undefined,
      // SMTP_DEBUG=true enables nodemailer's own sanitized wire logging.
      logger: debugEnabled ? { debug: (m) => smtpLog(`wire ${m}`), info: (m) => smtpLog(`wire ${m}`), error: (m) => smtpError("wire", { message: String(m) }) } : false,
      debug: debugEnabled,
    });
    smtpLog(
      `Transporter initialized — host=${config.smtp.host} port=${config.smtp.port} secure=${config.smtp.secure} user=${maskUser(config.smtp.user)}`
    );
    return transporter;
  } catch (err) {
    transporterError = err;
    smtpError("Transporter initialization failed", err);
    throw err;
  }
}

function maskUser(user) {
  if (!user) return "(missing)";
  const at = user.indexOf("@");
  return at > 0 ? `${user.slice(0, 2)}***${user.slice(at)}` : `${user.slice(0, 2)}***`;
}

function resetTransporter() {
  transporter = null;
  transporterError = null;
}

// --- status / verification -----------------------------------------------------

/**
 * Reports configuration presence + transport mode. NEVER includes credentials.
 */
function status() {
  return {
    configured: smtpConfigured(),
    host: config.smtp.host || null, // host name only — not a secret
    port: config.smtp.port || null,
    secure: Boolean(config.smtp.secure),
    fromEmail: config.smtp.fromEmail || null,
    fromName: config.smtp.fromName || null,
    baseUrl: baseUrl(),
    mock: Boolean(config.smtp.mockTransport),
    invitationExpiryMinutes: config.smtp.invitationExpiryMinutes,
    resetExpiryMinutes: config.smtp.resetExpiryMinutes,
  };
}

/**
 * Verifies connectivity + authentication with the configured transporter.
 * Returns { ok, message } — message is safe for API responses (no creds).
 */
async function verify() {
  if (!smtpConfigured()) {
    smtpError("Configuration validation failed — SMTP is not configured", {
      message: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD.",
    });
    return {
      ok: false,
      code: "SMTP_NOT_CONFIGURED",
      message: "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD.",
    };
  }
  try {
    smtpLog("Starting connection verification");
    const t = getTransporter();
    if (t._mock) {
      smtpLog("Mock transport active — verification skipped (test mode)");
      return { ok: true, message: "Mock transport active (test mode)." };
    }
    await t.verify();
    smtpLog("Authentication successful — TLS connection established and credentials accepted");
    return { ok: true, message: "SMTP connection and authentication verified." };
  } catch (err) {
    smtpError("Connection verification failed", err);
    return { ok: false, code: err.code || null, message: friendlySmtpError(err) };
  }
}

/** Maps nodemailer errors to administrator-actionable messages (no secrets). */
function friendlySmtpError(err) {
  const code = err.code || "";
  const msg = err.message || "SMTP error";
  if (code === "EAUTH" || /auth/i.test(msg)) {
    return "SMTP authentication failed — check SMTP_USER (full mailbox address) and SMTP_PASSWORD (the mailbox password, not the cPanel password).";
  }
  if (code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "ESOCKET") {
    return `Connection timed out reaching ${config.smtp.host}:${config.smtp.port}. Check the hostname and that the port matches your cPanel setting (465 SSL or 587 STARTTLS).`;
  }
  if (code === "ECONNECTION" || code === "ECONNREFUSED") {
    return `Could not connect to ${config.smtp.host}:${config.smtp.port}. Verify the outgoing mail server hostname in cPanel → Email Accounts → Connect Devices.`;
  }
  if (code === "EPROTO" || /ssl|tls|certificate/i.test(msg)) {
    return `TLS mismatch — if the server uses port 587 with STARTTLS, set SMTP_SECURE=false; for port 465 implicit SSL, set SMTP_SECURE=true. (${code || "TLS error"})`;
  }
  if (/sender|from/i.test(msg) && /reject/i.test(msg)) {
    return "The mail server rejected the sender address — SMTP_FROM_EMAIL must be the same mailbox as SMTP_USER.";
  }
  return `SMTP error: ${msg}`;
}

// --- templates ----------------------------------------------------------------

const BRAND = {
  name: "OneOps",
  accent: "#4f46e5",
  bg: "#f1f5f9",
};

function emailShell({ title, bodyHtml, ctaUrl, ctaLabel, footerNote }) {
  const cta = ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto"><tr><td style="background:${BRAND.accent};border-radius:10px">
         <a href="${ctaUrl}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none">${ctaLabel}</a>
       </td></tr></table>
       <p style="margin:8px 0 0;color:#64748b;font-size:12px;word-break:break-all">Or paste this link into your browser:<br>${ctaUrl}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.bg};font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:14px;padding:32px" cellpadding="0" cellspacing="0">
        <tr><td style="padding-bottom:20px;border-bottom:2px solid ${BRAND.accent}">
          <span style="font-size:19px;font-weight:800;color:${BRAND.accent}">${BRAND.name}</span>
        </td></tr>
        <tr><td style="padding-top:20px">
          <h1 style="margin:0 0 14px;font-size:18px;color:#0f172a">${title}</h1>
          ${bodyHtml}
          ${cta}
          ${footerNote ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">${footerNote}</p>` : ""}
        </td></tr>
      </table>
      <p style="margin-top:16px;color:#94a3b8;font-size:11px">This is an automated message from ${BRAND.name} — AntarXpress operations platform.</p>
    </td></tr>
  </table>
</body></html>`;
}

function invitationEmail({ fullName, activationUrl, expiryMinutes }) {
  const expiryHours = Math.round(expiryMinutes / 60);
  const expiryText = expiryMinutes >= 60 ? `${expiryHours} hour${expiryHours === 1 ? "" : "s"}` : `${expiryMinutes} minutes`;
  return {
    subject: "Your OneOps Account Invitation",
    html: emailShell({
      title: `Hello ${escapeHtml(fullName)},`,
      bodyHtml: `<p style="margin:0 0 8px;color:#334155;font-size:15px;line-height:1.6">Your OneOps account has been created.</p>
        <p style="margin:0;color:#334155;font-size:15px;line-height:1.6">Please use the link below to activate your account and set your password:</p>`,
      ctaUrl: activationUrl,
      ctaLabel: "Activate My Account",
      footerNote: `This link expires after ${expiryText} and can be used only once. If you did not expect this invitation, please contact your administrator.`,
    }),
    text:
      `Hello ${fullName},\n\n` +
      `Your OneOps account has been created.\n\n` +
      `Please use the link below to activate your account and set your password:\n` +
      `${activationUrl}\n\n` +
      `This link expires after ${expiryText} and can be used only once.\n` +
      `If you did not expect this invitation, please contact your administrator.\n\n` +
      `— OneOps, AntarXpress`,
  };
}

function passwordResetEmail({ fullName, resetUrl, expiryMinutes }) {
  return {
    subject: "Reset Your OneOps Password",
    html: emailShell({
      title: `Hello ${fullName},`,
      bodyHtml: `<p style="margin:0 0 8px;color:#334155;font-size:15px;line-height:1.6">We received a request to reset the password for your OneOps account.</p>
        <p style="margin:0;color:#334155;font-size:15px;line-height:1.6">Click the button below to choose a new password:</p>`,
      ctaUrl: resetUrl,
      ctaLabel: "Reset My Password",
      footerNote: `This link expires in ${expiryMinutes} minutes and can be used only once. If you did not request a password reset, you can safely ignore this email — your current password remains unchanged.`,
    }),
    text:
      `Hello ${fullName},\n\n` +
      `We received a request to reset the password for your OneOps account.\n\n` +
      `Use the link below to choose a new password:\n${resetUrl}\n\n` +
      `This link expires in ${expiryMinutes} minutes and can be used only once.\n` +
      `If you did not request this, ignore this email — your password remains unchanged.\n\n` +
      `— OneOps, AntarXpress`,
  };
}

function testEmail({ recipient }) {
  return {
    subject: "OneOps SMTP Test",
    html: emailShell({
      title: "SMTP configuration works",
      bodyHtml: `<p style="margin:0;color:#334155;font-size:15px;line-height:1.6">This is a test message from the OneOps email service. If you are reading this, the configured SMTP mailbox is sending correctly.</p>`,
      footerNote: "Triggered by an administrator from OneOps Access Management.",
    }),
    text: `OneOps SMTP test\n\nThis is a test message from the OneOps email service. If you received it, SMTP delivery works.\n`,
  };
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- sending --------------------------------------------------------------------

async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  const from =
    config.smtp.fromName && config.smtp.fromEmail
      ? `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`
      : config.smtp.user;

  const shortSubject = String(subject || "").slice(0, 60);
  smtpLog(`Sending message — subject="${shortSubject}" to=${maskUser(to)} mock=${Boolean(t._mock)}`);

  let info;
  try {
    info = await t.sendMail({ from, to, subject, html, text });
  } catch (err) {
    smtpError(`Message rejected — subject="${shortSubject}" to=${maskUser(to)}`, err);
    throw err;
  }

  // Never log message bodies or full URLs with tokens.
  const accepted = Array.isArray(info && info.accepted) ? info.accepted : [];
  if (!accepted.length) {
    smtpError(`SMTP server did not accept the message — subject="${shortSubject}" to=${maskUser(to)} rejected=${JSON.stringify(info && info.rejected || [])}`, {
      message: info && info.response ? String(info.response) : "no response",
    });
    const err = new Error("The mail server did not accept the message for delivery.");
    err.status = 502;
    throw err;
  }
  smtpLog(`Message accepted by SMTP server — response=${String(info.response || "").replace(/[\r\n]+/g, " ")} messageId=${info.messageId || "(none)"}`);
  return { acceptedTo: accepted[0] };
}

// --- typed senders ---------------------------------------------------------------

async function sendInvitation({ fullName, to, token }) {
  const url = `${baseUrl()}/activate-account?token=${encodeURIComponent(token)}`;
  const tpl = invitationEmail({ fullName, activationUrl: url, expiryMinutes: config.smtp.invitationExpiryMinutes });
  await sendMail({ to, ...tpl });
  return { url };
}

async function sendPasswordReset({ fullName, to, token }) {
  const url = `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const tpl = passwordResetEmail({ fullName, resetUrl: url, expiryMinutes: config.smtp.resetExpiryMinutes });
  await sendMail({ to, ...tpl });
  return { url };
}

async function sendTestEmail(to) {
  const tpl = testEmail({ recipient: to });
  await sendMail({ to, ...tpl });
  return true;
}

module.exports = {
  smtpConfigured,
  status,
  verify,
  sendInvitation,
  sendPasswordReset,
  sendTestEmail,
  resetTransporter,
  friendlySmtpError,
  smtpLog,
  smtpError,
  _internal: { emailShell, invitationEmail, passwordResetEmail, escapeHtml, mockOutbox },
};
