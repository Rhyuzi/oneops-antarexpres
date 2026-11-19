"use strict";

/**
 * OneOps backend — AntarXpress operations platform.
 *
 *  - Session auth (HMAC cookie) + users/roles from MySQL
 *  - Data Warrior storage API (folders/files/permissions/audit) on Cloudflare R2
 *  - Number Rechecking proxy (SiCepat) — preserved, now auth-protected
 *
 * Degrades gracefully: missing SESSION_SECRET disables login (503), missing
 * DB or R2 config keeps the server up and reports status on /api/health.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const { config } = require("./config");
const { checkDb } = require("./db");
const r2 = require("./r2");
const auth = require("./auth");
const { requirePermission, requireSuperAdmin } = require("./modulePermissions");
const requireSuperAdminStrict = requireSuperAdmin;
const storageRouter = require("./routes/storage");
const recheckRouter = require("./routes/recheck");
const accessManagementRouter = require("./routes/accessManagement");
const accountsRouter = require("./routes/accounts");
const emailAdminRouter = require("./routes/emailAdmin");
const auditTrailRouter = require("./routes/auditTrail");
const { auditHealth } = require("./audit");

const app = express();
const PORT = config.port;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// The frontend is served same-origin (Vite dev proxy / production static),
// so permissive CORS is unnecessary — removed from the original proxy.
app.use(auth.attachUser);

// ---------------------------------------------------------------------------
// Health / status
// ---------------------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  const db = await checkDb();
  const { r2Configured } = require("./config");
  // Do not contact R2 on every health check (rate limits); report config only.
  res.json({
    ok: db.ok,
    service: "oneops",
    version: "2.0.0",
    database: db,
    storage: { configured: r2Configured() },
    loginEnabled: auth.loginEnabled(),
    // Audit write failures since process start (details in the server log).
    audit: auditHealth(),
  });
});

app.get("/api/status/r2", auth.requireAuth, auth.requireRole("super_admin"), async (_req, res) => {
  const result = await r2.checkR2();
  res.json({ ok: result.ok, ...result });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post("/api/auth/login", auth.handleLogin);
app.post("/api/auth/logout", auth.handleLogout);
app.get("/api/auth/me", auth.handleMe);

// Public account lifecycle (no session): activation + password reset flows.
// Registered BEFORE any app.use("/api", ...) gate so no auth middleware runs.
app.post("/api/auth/activate-account", auth.handleActivateAccount);
app.post("/api/auth/forgot-password", auth.handleForgotPassword);
app.post("/api/auth/reset-password", auth.handleResetPassword);

// ---------------------------------------------------------------------------
// Feature APIs
// ---------------------------------------------------------------------------

// Data Warrior: module gate first, then per-route auth + folder permissions.
app.use("/api/storage", auth.requireAuth, requirePermission("data_warrior.view"), storageRouter);
// Access Management: super_admin only (hard rule).
app.use("/api/access-management", auth.requireAuth, requireSuperAdminStrict, accessManagementRouter);
// Account Management: module-permission gated per route.
app.use("/api/accounts", auth.requireAuth, accountsRouter);
// SMTP administration: super_admin only.
app.use("/api/admin/email", auth.requireAuth, requireSuperAdminStrict, emailAdminRouter);
// Audit Trail: read-only; audit_trail.view (super_admin via canonical bypass).
app.use("/api/audit-trail", auth.requireAuth, requirePermission("audit_trail.view"), auditTrailRouter);
// Number Rechecking proxy. Its auth + module gates live ON the /awb-detail
// route inside the router — never put middleware on a bare "/api" mount,
// or it runs for every /api/* request (that bug blocked password reset).
app.use("/api", recheckRouter);

// ---------------------------------------------------------------------------
// Static frontend (production)
// ---------------------------------------------------------------------------

const distDir = path.join(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// 404 + error handling
// ---------------------------------------------------------------------------

app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, message: "Not found." });
});

app.use((err, _req, res, _next) => {
  // Body-parser and validation errors land here.
  if (err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, message: "Request body too large." });
  }
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, message: "Invalid JSON body." });
  }
  console.error("[server] unhandled error:", err.message);
  return res.status(err.status || 500).json({ ok: false, message: "Server error." });
});

// ---------------------------------------------------------------------------

async function start() {
  // First-run convenience admin (only when users table is empty).
  if (auth.loginEnabled()) {
    await auth.bootstrapAdminIfEmpty();
  }

  app.listen(PORT, () => {
    console.log(`[oneops] backend listening on http://localhost:${PORT}`);
    if (!auth.loginEnabled()) {
      console.warn(
        "[oneops] SESSION_SECRET is not set — login is DISABLED. Set it to enable authentication."
      );
    }
    const { r2Configured } = require("./config");
    if (!r2Configured()) {
      console.warn("[oneops] R2 credentials incomplete — file storage APIs will return 503.");
    }
  });
}

start();
