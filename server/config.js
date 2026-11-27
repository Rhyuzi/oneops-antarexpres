"use strict";

/**
 * Central configuration for the OneOps backend.
 *
 * All values are read from environment variables with production-safe
 * defaults. Credentials are never logged and never exposed to the frontend.
 */

const path = require("path");

// ---------------------------------------------------------------------------
// Optional .env loader (local development convenience).
//
// Loads `/.env` from the project root ONLY for variables not already present
// in the environment — real environment variables (e.g. set through cPanel's
// "Setup Node.js App") always win, so production behavior is unchanged.
// No dependency: supports KEY=VALUE lines, # comments, optional quotes.
// ---------------------------------------------------------------------------
(function loadLocalEnv() {
  try {
    const fs = require("fs");
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    // .env is optional — never crash the server over it.
  }
})();

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const env = process.env;

const config = {
  env: env.NODE_ENV || "development",
  port: int(env.PORT, 3001),

  // --- MySQL (OneOps database) --------------------------------------------
  db: {
    host: env.DB_HOST || "localhost",
    port: int(env.DB_PORT, 3306),
    user: env.DB_USER || "oneops",
    password: env.DB_PASSWORD || "",
    database: env.DB_NAME || "oneops",
    connectionLimit: int(env.DB_CONNECTION_LIMIT, 5),
    // cPanel users often cannot create a dedicated DB user; keep the
    // timezone predictable regardless of server defaults.
    timezone: env.DB_TIMEZONE || "Z",
  },

  // --- Sessions -------------------------------------------------------------
  session: {
    // MUST be set in production. The server refuses to enable login when it
    // is missing or too short (see auth.js).
    secret: env.SESSION_SECRET || "",
    cookieName: "oneops_session",
    // 8 hours
    ttlSeconds: int(env.SESSION_TTL_SECONDS, 8 * 60 * 60),
    // Secure by default in production (HTTPS); set SESSION_SECURE_COOKIES=false
    // explicitly only for plain-HTTP local development.
    secureCookies: bool(env.SESSION_SECURE_COOKIES, env.NODE_ENV === "production"),
  },

  // --- Loader API recheck (server-side SiCepat queue) -----------------------
  // Clamped again in server/recheck/queue.js (concurrency 1–3, retries 0–5).
  loader: {
    recheckConcurrency: int(env.LOADER_RECHECK_CONCURRENCY, 2),
    recheckDelayMs: int(env.LOADER_RECHECK_DELAY_MS, 400),
    recheckMaxRetries: int(env.LOADER_RECHECK_MAX_RETRIES, 3),
    maxAwbPerJob: int(env.LOADER_MAX_AWB_PER_JOB, 3000),
    // Result 3PL (Data Warrior JNE layout)
    senderPhone: String(env.LOADER_SENDER_PHONE || "6282121221355").replace(/\D/g, "") || "6282121221355",
    jneService: String(env.LOADER_JNE_SERVICE || "REG").trim() || "REG",
  },

  // --- Bootstrap admin ------------------------------------------------------
  // If the users table is empty at startup and this password is set, an
  // 'admin' super_admin account is created automatically.
  bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD || "",

  // --- Cloudflare R2 ---------------------------------------------------------
  r2: {
    accountId: env.R2_ACCOUNT_ID || "",
    accessKeyId: env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
    bucketName: env.R2_BUCKET_NAME || "data-warrion",
    endpoint: env.R2_ENDPOINT || "",
    region: env.R2_REGION || "auto",
    forcePathStyle: bool(env.R2_FORCE_PATH_STYLE, true),
    publicUrl: (env.R2_PUBLIC_URL || "").replace(/\/+$/, ""),
    presignExpirySeconds: int(env.R2_PRESIGNED_URL_EXPIRY, 300),
    maxFileSize: int(env.R2_MAX_FILE_SIZE, 52428800), // 50 MB
  },

  // --- SMTP (cPanel mailbox) --------------------------------------------------
  smtp: {
    host: env.SMTP_HOST || "",
    port: int(env.SMTP_PORT, 465),
    secure: bool(env.SMTP_SECURE, true),
    user: env.SMTP_USER || "",
    password: env.SMTP_PASSWORD || "",
    fromName: env.SMTP_FROM_NAME || "OneOps",
    fromEmail: env.SMTP_FROM_EMAIL || env.SMTP_USER || "",
    baseUrl: env.APP_BASE_URL || "",
    invitationExpiryMinutes: int(env.ACCOUNT_INVITATION_EXPIRY_MINUTES, 1440),
    resetExpiryMinutes: int(env.PASSWORD_RESET_EXPIRY_MINUTES, 30),
    // Automated tests swap the transport; never sends real mail.
    // (bool("mock") is false, so the previous `bool(...) === true && ... === "mock"`
    // could never be true and EMAIL_TRANSPORT=mock still sent real mail.)
    mockTransport: String(env.EMAIL_TRANSPORT || "").trim().toLowerCase() === "mock",
  },

  // --- Password policy ----------------------------------------------------------
  passwords: {
    minLength: int(env.PASSWORD_MIN_LENGTH, 8),
    requireUpper: bool(env.PASSWORD_REQUIRE_UPPER, true),
    requireLower: bool(env.PASSWORD_REQUIRE_LOWER, true),
    requireDigit: bool(env.PASSWORD_REQUIRE_DIGIT, true),
    requireSymbol: bool(env.PASSWORD_REQUIRE_SYMBOL, true),
  },

  // --- Upload validation -------------------------------------------------------
  upload: {
    // Allowed file extensions (lowercase, no dot). Office/PDF/image/text.
    allowedExtensions: [
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
      "jpg", "jpeg", "png", "gif", "webp",
      "txt", "csv", "md",
      "zip", "rar", "7z",
    ],
    // Secondary MIME allow-list used only when the browser reports a MIME
    // type. application/octet-stream is accepted because many browsers send
    // it for Office formats.
    allowedMimePrefixes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/x-mspublisher",
      "image/",
      "text/",
      "application/json",
      "application/zip",
      "application/x-zip-compressed",
      "application/x-rar-compressed",
      "application/vnd.rar",
      "application/x-7z-compressed",
      "application/octet-stream",
    ],
  },
};

function r2Configured() {
  return Boolean(
    config.r2.accessKeyId &&
    config.r2.secretAccessKey &&
    config.r2.bucketName &&
    config.r2.endpoint
  );
}

function dbConfigured() {
  return Boolean(config.db.database);
}

module.exports = { config, r2Configured, dbConfigured };
