"use strict";

/**
 * MySQL connection pool for the OneOps database.
 *
 * Degrades gracefully: when the database is not reachable the pool is still
 * created (mysql2 connects lazily) and every query helper returns a clean
 * error, so the Express server can boot and report its status on /api/health.
 */

const mysql = require("mysql2/promise");
const { config, dbConfigured } = require("./config");

let pool = null;

if (dbConfigured()) {
  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    charset: "utf8mb4_unicode_ci",
    timezone: config.db.timezone,
    dateStrings: true,
    // Keep failures fast so the API answers with a clean 503 instead of
    // hanging requests when the database is down on shared hosting.
    connectTimeout: 10000,
    enableKeepAlive: true,
  });
}

/** True when the pool exists and a test query succeeds. */
async function checkDb() {
  if (!pool) return { ok: false, reason: "database not configured" };
  try {
    await pool.query("SELECT 1 AS ok");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.code || err.message };
  }
}

/**
 * Run a query. Returns rows (or a result object for non-SELECT queries).
 * Throws with a normalized error so route handlers can map to 503.
 */
async function query(sql, params) {
  if (!pool) {
    const err = new Error("Database is not configured");
    err.status = 503;
    throw err;
  }
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    err.status = 503;
    // Never leak credentials (there are none in errors, but keep the log lean).
    err.dbMessage = `${err.code || ""} ${err.sqlMessage || err.message}`.trim();
    throw err;
  }
}

module.exports = { pool, query, checkDb };
