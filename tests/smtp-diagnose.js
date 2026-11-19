"use strict";

/**
 * SMTP end-to-end diagnostics — prints SAFE information only.
 * NEVER prints SMTP_PASSWORD or any credential value.
 *
 * Usage: node tests/smtp-diagnose.js [--send-test recipient@example.com]
 *   --send-test additionally submits a real test email (explicit recipient only).
 */

const dns = require("dns");
const net = require("net");
const tls = require("tls");
const nodemailer = require("nodemailer");

// Load the same config the server uses (incl. the .env loader).
const { config } = require("../server/config");
const emailService = require("../server/emailService");

const stamp = () => new Date().toISOString();
function log(msg) {
  console.log(`[SMTP] ${stamp()} ${msg}`);
}

function maskUser(user) {
  if (!user) return "(missing)";
  const at = user.indexOf("@");
  return at > 0 ? `${user.slice(0, 2)}***${user.slice(at)}` : `${user.slice(0, 2)}***`;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

(async () => {
  console.log("\n=== [SMTP] Configuration diagnostics ===\n");

  // --- 1. configuration presence (no secrets) --------------------------------
  const s = config.smtp;
  log(`Configuration loaded: host=${s.host || "(MISSING)"}, port=${typeof s.port}:${s.port}, secure=${typeof s.secure}:${s.secure}`);
  log(`user=${maskUser(s.user)}, password=${s.password ? "present(len " + s.password.length + ")" : "(MISSING/EMPTY)"}`);
  log(`from="${s.fromName}" <${s.fromEmail}>, baseUrl=${s.baseUrl || "(default)"}, mock=${s.mockTransport}`);

  record("SMTP_HOST present", Boolean(s.host), s.host || "missing");
  record("SMTP_PORT numeric", Number.isInteger(s.port) && s.port > 0, String(s.port));
  record("SMTP_SECURE boolean", typeof s.secure === "boolean", String(s.secure));
  record("SMTP_USER present", Boolean(s.user), maskUser(s.user));
  record("SMTP_PASSWORD present + non-empty", typeof s.password === "string" && s.password.length > 0, s.password ? `length ${s.password.length}` : "empty");
  record("SMTP_FROM_EMAIL present", Boolean(s.fromEmail), s.fromEmail || "missing");
  record("SMTP_FROM_NAME present", Boolean(s.fromName), s.fromName || "missing");
  record("APP_BASE_URL loaded", Boolean(s.baseUrl), s.baseUrl || "missing (falls back to localhost)");
  record("Port/secure pair consistent", (s.port === 465 && s.secure === true) || (s.port === 587 && s.secure === false) || (s.port === 25 && s.secure === false), `${s.port}/${s.secure}`);

  if (s.mockTransport) {
    log("EMAIL_TRANSPORT=mock is active — real SMTP will NOT be contacted. Remove it to test live delivery.");
  }

  // --- 2. DNS ---------------------------------------------------------------
  console.log("\n=== [SMTP] DNS resolution ===\n");
  let addresses = [];
  try {
    addresses = await dns.promises.resolve4(s.host);
    log(`DNS resolution successful: ${s.host} → ${addresses.join(", ")}`);
    record("DNS resolution", true, addresses.join(","));
  } catch (err) {
    log(`DNS resolution FAILED: ${err.code || err.message}`);
    record("DNS resolution", false, `${err.code || ""} ${err.message}`);
    if (err.code === "ENOTFOUND") {
      console.log("\nRoot cause: hostname does not resolve. Verify SMTP_HOST in cPanel → Email Accounts → Connect Devices.");
    }
  }

  // --- 3. TCP connectivity ---------------------------------------------------
  console.log("\n=== [SMTP] TCP connectivity ===\n");
  const tcpOk = await new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok, why) => {
      sock.destroy();
      resolve({ ok, why });
    };
    sock.setTimeout(10000);
    sock.once("connect", () => {
      log(`TCP connection established to ${s.host}:${s.port}`);
      done(true, "");
    });
    sock.once("timeout", () => {
      log(`TCP connection TIMED OUT to ${s.host}:${s.port} (10s)`);
      done(false, "timeout");
    });
    sock.once("error", (err) => {
      log(`TCP connection FAILED to ${s.host}:${s.port}: ${err.code || err.message}`);
      done(false, `${err.code || err.message}`);
    });
    sock.connect(s.port, s.host);
  });
  record("Port connectivity", tcpOk.ok, tcpOk.why || `${s.host}:${s.port}`);
  if (!tcpOk.ok && /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(tcpOk.why || "")) {
    console.log("Likely causes: local ISP/firewall blocking outbound 465, or the mail server blocks your network. Try port 587 from cPanel's Connect Devices page.");
  }

  // --- 4. TLS negotiation ----------------------------------------------------
  console.log("\n=== [SMTP] TLS negotiation ===\n");
  let tlsOk = false;
  if (tcpOk.ok && s.secure) {
    tlsOk = await new Promise((resolve) => {
      const sock = tls.connect(
        { host: s.host, port: s.port, servername: s.host, rejectUnauthorized: true },
        () => {
          const cert = sock.getPeerCertificate();
          const cn = cert && cert.subject ? cert.subject.CN || "(none)" : "(none)";
          const validTo = cert && cert.valid_to ? cert.valid_to : "?";
          log(`TLS connection established — protocol ${sock.getProtocol()}, cert CN=${cn}, valid until ${validTo}`);
          sock.end();
          resolve(true);
        }
      );
      sock.setTimeout(10000);
      sock.once("timeout", () => {
        log("TLS negotiation TIMED OUT");
        sock.destroy();
        resolve(false);
      });
      sock.once("error", (err) => {
        log(`TLS negotiation FAILED: ${err.code || err.message}`);
        sock.destroy();
        resolve(false);
      });
    });
    record("TLS negotiation (cert verified, not bypassed)", tlsOk, tlsOk ? "ok" : "see log above");
  } else {
    console.log("Skipped (secure=false → STARTTLS happens inside the SMTP session; covered by verify()).");
    tlsOk = tcpOk.ok;
    record("TLS negotiation", tlsOk, "deferred to SMTP session (STARTTLS)");
  }

  // --- 5. Full nodemailer verify (DNS+TCP+TLS+AUTH) ---------------------------
  console.log("\n=== [SMTP] transporter.verify() (connection + authentication) ===\n");
  log("Starting connection verification");
  let verifyOk = false;
  if (!s.mockTransport && s.host && s.user && s.password) {
    const t = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: { user: s.user, pass: s.password },
      connectionTimeout: 15000,
      greetingTimeout: 12000,
      socketTimeout: 20000,
    });
    try {
      await t.verify();
      log("Authentication successful — SMTP connection verified");
      verifyOk = true;
    } catch (err) {
      log(`Connection verification failed: code=${err.code || "(none)"} message=${err.message.replace(/[\r\n]+/g, " ")}`);
      if (err.code === "EAUTH" || /auth/i.test(err.message || "")) {
        console.log("  → AUTH failure: confirm SMTP_USER is the FULL mailbox address and SMTP_PASSWORD is the mailbox password (not the cPanel password).");
        console.log("  → cPanel response detail: " + (err.response || "(server gave no response text)"));
      }
    }
    t.close();
  } else {
    log("Skipped verify: configuration incomplete or mock transport.");
  }
  record("Nodemailer transporter.verify()", verifyOk, verifyOk ? "authenticated" : "see log above");

  // --- 6. Optional real test email -------------------------------------------
  const argIdx = process.argv.indexOf("--send-test");
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const recipient = process.argv[argIdx + 1];
    console.log(`\n=== [SMTP] Test email submission → ${recipient} ===\n`);
    log("Sending test email");
    try {
      const info = await nodemailer
        .createTransport({
          host: s.host, port: s.port, secure: s.secure,
          auth: { user: s.user, pass: s.password },
        })
        .sendMail({
          from: `"${s.fromName}" <${s.fromEmail}>`,
          to: recipient,
          subject: "OneOps SMTP Delivery Test",
          text: "This is an end-to-end SMTP test from OneOps. If you received this email, SMTP authentication and message submission are working.",
        });
      log(`Message accepted by SMTP server — response: ${info.response}`);
      record("Test email submission", Array.isArray(info.accepted) && info.accepted.length > 0, `accepted=${JSON.stringify(info.accepted)} messageId=${info.messageId}`);
      console.log("NOTE: SMTP acceptance ≠ confirmed inbox delivery. Check the recipient mailbox (and spam).");
    } catch (err) {
      log(`Message rejected: code=${err.code || "(none)"} message=${err.message.replace(/[\r\n]+/g, " ")}`);
      record("Test email submission", false, `${err.code || ""} ${err.message}`);
    }
  }

  // --- summary ----------------------------------------------------------------
  console.log("\n=== [SMTP] Summary ===\n");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("[SMTP] Unexpected diagnostic failure:", err.message);
  process.exit(1);
});
