"use strict";

/**
 * Number Rechecking API (preserved from the original app, now auth-protected).
 *
 * The browser still cannot call SiCepat directly (CORS); this proxy forwards
 * /api/awb-detail. SiCepat credentials continue to arrive per-request from
 * the user's Settings page — they are never stored server-side.
 *
 * Change vs the original: every request now requires a valid OneOps session.
 */

const express = require("express");
const { requireAuth } = require("../auth");
const { requirePermission } = require("../modulePermissions");
const { logAudit } = require("../audit");
const { lookupAwb, credentialsFromRequest, isAuthStatus } = require("../recheck/sicepatClient");

const router = express.Router();

// Audit policy for this proxy: individual AWB lookups are NOT audited (a batch
// is thousands of calls, and storing AWB→phone pairs in the audit table would
// itself leak personal data). What IS audited is SiCepat rejecting the
// configured credentials (security-relevant), at most once per user per
// window so a failing batch does not flood the trail.
const CREDENTIAL_AUDIT_WINDOW_MS = 10 * 60 * 1000;
const lastCredentialAudit = new Map();

function auditCredentialRejection(req, upstreamStatus) {
  const key = req.user ? req.user.id : "anon";
  const now = Date.now();
  if (now - (lastCredentialAudit.get(key) || 0) < CREDENTIAL_AUDIT_WINDOW_MS) return;
  lastCredentialAudit.set(key, now);
  void logAudit({
    req,
    action: "recheck.credentials_rejected",
    entityType: "sicepat_api",
    result: "failure",
    metadata: { upstream_status: upstreamStatus },
  });
}

router.post("/awb-detail", requireAuth, requirePermission("number_rechecking.run"), async (req, res) => {
  const body = req.body || {};
  const awbNumber = body.awb_number;
  const creds = credentialsFromRequest(req, "user_id");

  if (!creds) {
    return res.status(400).json({
      ok: false,
      status: 400,
      message: "Missing SiCepat credentials. Configure them in Settings.",
    });
  }
  if (typeof awbNumber !== "string" || !awbNumber.trim()) {
    return res.status(400).json({ ok: false, status: 400, message: "Missing AWB number." });
  }

  const result = await lookupAwb({ awb: awbNumber, ...creds });
  if (result.ok) return res.json({ ok: true, status: result.status, value: result.value });

  console.error("[recheck] Upstream status:", result.status);
  console.error("[recheck] Upstream response:", JSON.stringify(result.upstream, null, 2));
  if (isAuthStatus(result.status)) auditCredentialRejection(req, result.status);
  return res.status(result.status || 502).json({ ok: false, status: result.status || 502, message: result.message });
});

module.exports = router;
