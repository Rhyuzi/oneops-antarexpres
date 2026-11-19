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
const axios = require("axios");
const { requireAuth } = require("../auth");
const { requirePermission } = require("../modulePermissions");
const { logAudit } = require("../audit");

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

const SICEPAT_BASE_URL =
  (process.env.SICEPAT_BASE_URL || "https://podapi.sicepat.com/")
    .trim()
    .replace(/\/+$/, "") + "/";
const SICEPAT_URL = `${SICEPAT_BASE_URL}web/v1/tracking/awbDetail`;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function headerString(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

router.post("/awb-detail", requireAuth, requirePermission("number_rechecking.run"), async (req, res) => {
  const body = req.body || {};
  const awbNumber = body.awb_number;
  const userId = body.user_id;

  const bearerToken = (() => {
    const m = headerString(req.headers.authorization).match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : "";
  })();
  const permissionToken = headerString(req.headers["x-permission-token"]);

  if (!isNonEmptyString(bearerToken) || !isNonEmptyString(permissionToken)) {
    return res.status(400).json({
      ok: false,
      status: 400,
      message: "Missing SiCepat credentials. Configure them in Settings.",
    });
  }
  if (!isNonEmptyString(awbNumber)) {
    return res.status(400).json({ ok: false, status: 400, message: "Missing AWB number." });
  }

  try {
    const response = await axios.post(
      SICEPAT_URL,
      {
        key: "handphone",
        type: "-",
        awb_number: String(awbNumber),
        user_id: String(userId || ""),
      },
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://pod.sicepat.com",
          Referer: "https://pod.sicepat.com/",
          "x-permission-token": permissionToken,
        },
        timeout: 20000,
      }
    );

    const data = response.data || {};
    const value = data.value === undefined || data.value === null ? "" : String(data.value);
    return res.json({ ok: true, status: response.status, value });
  } catch (err) {
    const status = err.response ? err.response.status : 0;
    const upstreamData = err.response ? err.response.data : null;

    console.error("[recheck] Upstream status:", status);
    console.error("[recheck] Upstream response:", JSON.stringify(upstreamData, null, 2));

    if (status === 401 || status === 403) auditCredentialRejection(req, status);

    let message;
    if (status === 401) message = "Authorization failed — token is invalid or expired.";
    else if (status === 403) message = "Forbidden — insufficient permission.";
    else if (status === 429) message = "Rate limited by SiCepat.";
    else if (status === 400) message = "SiCepat rejected the request (bad request).";
    else if (status === 404) message = "AWB not found.";
    else if (status >= 500) message = `SiCepat server error (HTTP ${status}).`;
    else if (status === 0) message = "Network error — could not reach SiCepat.";
    else message = `Request failed (HTTP ${status}).`;

    return res.status(status || 502).json({ ok: false, status: status || 502, message });
  }
});

module.exports = router;
