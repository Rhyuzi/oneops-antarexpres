"use strict";

/**
 * SiCepat Bulk Phone Rechecker — local API proxy.
 *
 * The browser cannot call the SiCepat API directly (CORS), so this small
 * Express server forwards `/api/awb-detail` requests. It runs only on the
 * local machine and never logs credentials.
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Base URL is configurable via SICEPAT_BASE_URL (defaults to the production
// SiCepat POD origin). The AWB detail path is appended to it.
const SICEPAT_BASE_URL =
  (process.env.SICEPAT_BASE_URL || "https://podapi.sicepat.com/")
    .trim()
    .replace(/\/+$/, "") + "/";
const SICEPAT_URL = `${SICEPAT_BASE_URL}web/v1/tracking/awbDetail`;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Local-only CORS (development convenience; the Vite dev server proxies /api
// to this server so requests are normally same-origin anyway).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-permission-token",
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "sicepat-proxy" });
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function headerString(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function extractBearerToken(authorization) {
  const header = headerString(authorization);
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

app.post("/api/awb-detail", async (req, res) => {
  const body = req.body || {};
  const awbNumber = body.awb_number;
  const userId = body.user_id;

  // Credentials arrive via HTTP headers (never in the JSON body).
  const bearerToken = extractBearerToken(req.headers.authorization);
  const permissionToken = headerString(req.headers["x-permission-token"]);

  if (!isNonEmptyString(bearerToken) || !isNonEmptyString(permissionToken)) {
    return res.status(400).json({
      ok: false,
      status: 400,
      message:
        "Missing credentials. Configure Bearer Token and X-Permission-Token in Settings.",
    });
  }

  if (!isNonEmptyString(awbNumber)) {
    return res
      .status(400)
      .json({ ok: false, status: 400, message: "Missing AWB number." });
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
      },
    );

    const data = response.data || {};
    const value =
      data.value === undefined || data.value === null ? "" : String(data.value);

    return res.json({ ok: true, status: response.status, value });
  } catch (err) {
    const status = err.response ? err.response.status : 0;
    const upstreamData = err.response ? err.response.data : null;

    // Debug response from SiCepat. Never log credentials.
    console.error("[sicepat-proxy] Upstream status:", status);
    console.error(
      "[sicepat-proxy] Upstream response:",
      JSON.stringify(upstreamData, null, 2),
    );

    let message;

    if (status === 401)
      message = "Authorization failed — token is invalid or expired.";
    else if (status === 403) message = "Forbidden — insufficient permission.";
    else if (status === 429) message = "Rate limited by SiCepat.";
    else if (status === 400)
      message = "SiCepat rejected the request (bad request).";
    else if (status === 404) message = "AWB not found.";
    else if (status >= 500) message = `SiCepat server error (HTTP ${status}).`;
    else if (status === 0) message = "Network error — could not reach SiCepat.";
    else message = `Request failed (HTTP ${status}).`;

    return res.status(status || 502).json({
      ok: false,
      status: status || 502,
      message,
    });
  }
});

// Serve the built frontend when present (production-ish local usage).
const distDir = path.join(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(
    `[sicepat-proxy] SiCepat Bulk Phone Rechecker backend listening on http://localhost:${PORT}`,
  );
});
