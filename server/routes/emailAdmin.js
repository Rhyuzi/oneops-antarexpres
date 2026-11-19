"use strict";

/**
 * SMTP administration — super_admin only.
 * Status/verify/test. Never exposes credentials, never auto-sends.
 */

const express = require("express");
const { requireSuperAdmin } = require("../modulePermissions");
const emailService = require("../emailService");
const { logAudit } = require("../audit");

const router = express.Router();
router.use(requireSuperAdmin);

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// GET /api/admin/email/status — configuration presence only (no secrets)
router.get("/status", (_req, res) => {
  const s = emailService.status();
  // status() includes host/port/from which are not secrets but keep the
  // response minimal for safety.
  return res.json({
    ok: true,
    status: {
      configured: s.configured,
      secure: s.secure,
      mock: s.mock,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      baseUrl: s.baseUrl,
      invitationExpiryMinutes: s.invitationExpiryMinutes,
      resetExpiryMinutes: s.resetExpiryMinutes,
    },
  });
});

// POST /api/admin/email/verify — connectivity + auth check (no email sent)
router.post("/verify", async (req, res) => {
  const result = await emailService.verify();
  logAudit({
    userId: req.user.id,
    action: "smtp.verify",
    entityType: "email",
    entityId: null,
    metadata: { ok: result.ok, code: result.code || null },
    ip: clientIp(req),
  }).catch(() => {});
  return res.json({ ok: result.ok, message: result.message });
});

// POST /api/admin/email/test — send a test email to ONE explicit recipient
router.post("/test", async (req, res) => {
  const { to } = req.body || {};
  if (typeof to !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return res.status(400).json({ ok: false, message: "A valid recipient email is required." });
  }
  try {
    await emailService.sendTestEmail(to);
    logAudit({
      userId: req.user.id,
      action: "smtp.test_email",
      entityType: "email",
      entityId: null,
      metadata: { recipient: to, result: "sent" },
      ip: clientIp(req),
    }).catch(() => {});
    return res.json({ ok: true, message: `Test email sent to ${to}.` });
  } catch (err) {
    logAudit({
      userId: req.user.id,
      action: "smtp.test_email",
      entityType: "email",
      entityId: null,
      metadata: { recipient: to, result: "failed", code: err.code || null },
      ip: clientIp(req),
    }).catch(() => {});
    if (err.code === "SMTP_NOT_CONFIGURED") {
      return res.status(503).json({ ok: false, message: err.message });
    }
    return res.status(502).json({
      ok: false,
      message: emailService.friendlySmtpError(err),
    });
  }
});

module.exports = router;
