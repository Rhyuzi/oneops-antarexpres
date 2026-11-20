"use strict";

/**
 * Shared SiCepat "awbDetail" client — ONE place that talks to SiCepat, used by
 *   - the browser rechecker proxy   (server/routes/recheck.js → /api/awb-detail)
 *   - the loader's server-side queue (server/loader/jobs.js, API mode)
 *
 * Credentials: NEVER stored by OneOps. They come from the user's existing
 * rechecker token settings (browser) with each request — the same headers the
 * proxy has always used (Authorization: Bearer …, x-permission-token, plus the
 * SiCepat user id) — and are only passed through to SiCepat.
 *
 * SICEPAT_BASE_URL (env) can point to a mock server for tests.
 */

const axios = require("axios");

function sicepatUrl() {
  const base = (process.env.SICEPAT_BASE_URL || "https://podapi.sicepat.com/").trim().replace(/\/+$/, "") + "/";
  return `${base}web/v1/tracking/awbDetail`;
}

const RETRYABLE = new Set([0, 429, 500, 502, 503, 504]);

function isRetryableStatus(status) {
  return RETRYABLE.has(Number(status));
}

function isAuthStatus(status) {
  return status === 401 || status === 403;
}

/** User-facing message for an upstream status (localized in the UI). */
function messageForStatus(status) {
  if (status === 401) return "Authorization failed — token is invalid or expired.";
  if (status === 403) return "Forbidden — insufficient permission.";
  if (status === 429) return "Rate limited by SiCepat.";
  if (status === 400) return "SiCepat rejected the request (bad request).";
  if (status === 404) return "AWB not found.";
  if (status >= 500) return `SiCepat server error (HTTP ${status}).`;
  if (status === 0) return "Network error — could not reach SiCepat.";
  return `Request failed (HTTP ${status}).`;
}

function headerString(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

/**
 * Credentials as sent by the existing rechecker token system:
 * Authorization: Bearer <token>, x-permission-token: <token>, user id in body.
 * Returns null when either token is missing.
 */
function credentialsFromRequest(req, bodyUserIdField = "user_id") {
  const m = headerString(req.headers.authorization).match(/^Bearer\s+(.+)$/i);
  const bearerToken = m ? m[1].trim() : "";
  const permissionToken = headerString(req.headers["x-permission-token"]).trim();
  const body = req.body || {};
  const userId = String(body[bodyUserIdField] === undefined || body[bodyUserIdField] === null ? "" : body[bodyUserIdField]).trim();
  if (!bearerToken || !permissionToken) return null;
  return { bearerToken, permissionToken, userId };
}

/**
 * Looks up one AWB. Never throws.
 * @returns {Promise<{ok: true, status: number, value: string} | {ok: false, status: number, message: string, upstream?: unknown}>}
 */
async function lookupAwb({ awb, bearerToken, permissionToken, userId, timeoutMs = 20000 }) {
  try {
    const response = await axios.post(
      sicepatUrl(),
      { key: "handphone", type: "-", awb_number: String(awb), user_id: String(userId || "") },
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://pod.sicepat.com",
          Referer: "https://pod.sicepat.com/",
          "x-permission-token": permissionToken,
        },
        timeout: timeoutMs,
      }
    );
    const data = response.data || {};
    const value = data.value === undefined || data.value === null ? "" : String(data.value);
    return { ok: true, status: response.status, value };
  } catch (err) {
    const status = err.response ? err.response.status : 0;
    return { ok: false, status, message: messageForStatus(status), upstream: err.response ? err.response.data : null };
  }
}

module.exports = {
  sicepatUrl,
  lookupAwb,
  messageForStatus,
  credentialsFromRequest,
  isRetryableStatus,
  isAuthStatus,
};
