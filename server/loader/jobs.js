"use strict";

/**
 * Loader jobs: run history (table loader_jobs) + the in-memory runner for API
 * mode (server-side SiCepat recheck, then Rules 1–16).
 *
 * Security / privacy rules enforced here:
 *  - SiCepat credentials live ONLY in the in-memory job while its queue runs
 *    and are wiped (job.credentials = null) as soon as the queue stops for
 *    any reason. They are never written to the DB, the audit trail or logs.
 *  - loader_jobs stores counts and error codes — never recipient phones.
 *  - Results (the .xlsx) stay in memory for RESULT_TTL_MS, owner-only.
 *
 * A token rejected mid-run PAUSES the job (status "paused"); the user updates
 * the token in the rechecker settings and resumes — finished AWBs are kept.
 * A server restart loses in-memory state: such jobs are marked "interrupted".
 */

const crypto = require("crypto");
const { query } = require("../db");
const { config } = require("../config");
const { logAudit } = require("../audit");
const { runRecheckQueue } = require("../recheck/queue");
const { lookupAwb } = require("../recheck/sicepatClient");
const { buildLoaderFile } = require("./service");

const RESULT_TTL_MS = 15 * 60 * 1000;
const MAX_RESULTS = 30;
const MEMORY_TTL_MS = 60 * 60 * 1000; // finished jobs stay inspectable for 1 h
const PERSIST_EVERY_MS = 2000;
const FAILURE_LIST_CAP = 500;

const newId = () => crypto.randomBytes(16).toString("hex");
const isMissingTable = (err) => err && (err.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(err.message || ""));

// ---------------------------------------------------------------------------
// Download store (both modes)
// ---------------------------------------------------------------------------

const results = new Map(); // id → { userId, buffer, filename, expiresAt }

function pruneResults() {
  const now = Date.now();
  for (const [id, r] of results) if (r.expiresAt <= now) results.delete(id);
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
}

function storeResult(userId, buffer, filename) {
  pruneResults();
  const id = newId();
  const expiresAt = Date.now() + RESULT_TTL_MS;
  results.set(id, { userId, buffer, filename, expiresAt });
  return { id, filename, expiresAt: new Date(expiresAt).toISOString() };
}

function getResult(id, userId) {
  pruneResults();
  const entry = results.get(String(id));
  return entry && entry.userId === userId ? entry : null;
}

// ---------------------------------------------------------------------------
// History table (best-effort when migration 011 is missing)
// ---------------------------------------------------------------------------

let historyWarned = false;
function historyUnavailable(err) {
  if (isMissingTable(err)) {
    if (!historyWarned) console.warn("[loader] loader_jobs table missing — job history disabled (run migration 011).");
    historyWarned = true;
    return true;
  }
  console.error("[loader] job history write failed:", err.dbMessage || err.message);
  return true;
}

async function insertJobRow(job) {
  try {
    await query(
      `INSERT INTO loader_jobs
         (public_id, user_id, mode, status, template_name, rechecked_name, wilayah,
          cust_id_cod, cust_id_non_cod, total_rows, total_awb, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [job.publicId, job.userId, job.mode, job.status, job.templateName.slice(0, 200), job.recheckedName || null,
        (job.wilayahLabel || job.wilayah || "").slice(0, 100) || null, job.ids.cod, job.ids.nonCod, job.totalRows, job.awbs ? job.awbs.length : 0]
    );
  } catch (err) {
    historyUnavailable(err);
  }
}

async function persistJob(job, { final = false } = {}) {
  job.lastPersist = Date.now();
  const c = counts(job);
  try {
    await query(
      `UPDATE loader_jobs
          SET status = ?, processed_awb = ?, success_awb = ?, failed_awb = ?,
              error_code = ?, error_message = ?, summary = ?,
              output_filename = ?, download_id = ?, download_expires_at = ?,
              finished_at = ${final ? "NOW()" : "finished_at"}
        WHERE public_id = ?`,
      [job.status, c.processed, c.success, c.failed,
        job.error ? job.error.code : null, job.error ? String(job.error.message || "").slice(0, 300) : null,
        job.summary ? JSON.stringify(job.summary) : null,
        job.download ? job.download.filename : null, job.download ? job.download.id : null,
        job.download ? new Date(job.download.expiresAt) : null,
        job.publicId]
    );
  } catch (err) {
    historyUnavailable(err);
  }
}

/** Startup: jobs that were mid-run when the process stopped cannot continue. */
async function markInterruptedJobs() {
  try {
    const r = await query(
      `UPDATE loader_jobs SET status = 'interrupted', error_code = 'SERVER_RESTART', finished_at = NOW()
        WHERE status IN ('running', 'processing', 'paused')`
    );
    if (Number(r.affectedRows)) console.warn(`[loader] marked ${r.affectedRows} unfinished job(s) as interrupted.`);
  } catch (err) {
    if (!isMissingTable(err)) console.error("[loader] could not mark interrupted jobs:", err.dbMessage || err.message);
  }
}

// ---------------------------------------------------------------------------
// In-memory jobs (API mode)
// ---------------------------------------------------------------------------

const jobs = new Map(); // publicId → job

function counts(job) {
  if (!job.results) return { total: 0, processed: 0, success: 0, failed: 0 };
  let success = 0;
  let failed = 0;
  for (const r of job.results.values()) r.status === "success" ? success++ : failed++;
  return { total: job.awbs.length, processed: success + failed, success, failed };
}

/** DB summary: counts only — no phone numbers. */
function summarize(report, recheck) {
  const s = {
    rows: report.rows,
    cod: report.cod,
    nonCod: report.nonCod,
    weightConversion: report.weight.conversion !== false,
    weightNormalized: report.weight.normalized,
    weightGuarded: report.weight.guardSkipped,
    kodeposFilled: report.kodepos.filled,
    kodeposMissing: report.kodepos.missing.map((m) => m.kecamatan),
    kodeposAmbiguous: report.kodepos.ambiguous.map((m) => m.kecamatan),
    phonesFromSource: report.phone.fromRechecked,
    phonesInvalid: report.phone.invalid.length,
    unknownCod: report.unknownCod.length,
    // Counts / hub names only — no Resi, names or phone numbers.
    addressCleaned: report.addressCleaned || 0,
    emptyCells: report.empty ? report.empty.cells : 0,
    emptyRows: report.empty ? report.empty.rowsWithEmpty : 0,
    emptyColumns: report.empty ? report.empty.emptyColumns : [],
    // Wilayah / kota of the form and the sender columns (no customer data).
    sender: report.sender || null,
    duplicateResi: report.duplicateResi ? report.duplicateResi.groups : 0,
    duplicateResiRows: report.duplicateResi ? report.duplicateResi.rows : 0,
    kotaPenerimaMapped: report.kotaPenerima ? report.kotaPenerima.mapped : 0,
    kotaPenerimaFallback: report.kotaPenerima ? report.kotaPenerima.fallback : 0,
    kotaPenerimaFallbackHubs: report.kotaPenerima
      ? report.kotaPenerima.fallbackGroups.map((g) => ({ hub: g.hub, kotaTujuan: g.kotaTujuan, reason: g.reason, count: g.count }))
      : [],
  };
  if (recheck) s.recheck = { total: recheck.total, success: recheck.success, failed: recheck.failed, byCode: recheck.byCode };
  return s;
}

function failureSummary(job) {
  const byCode = {};
  const failures = [];
  for (const [key, r] of job.results) {
    if (r.status === "success") continue;
    byCode[r.code] = (byCode[r.code] || 0) + 1;
    if (failures.length < FAILURE_LIST_CAP) {
      failures.push({ resi: job.awbByKey.get(key) || key, code: r.code, httpStatus: r.httpStatus, message: r.message });
    }
  }
  return { byCode, failures };
}

function hasActiveJob(userId) {
  for (const j of jobs.values()) {
    if (j.userId === userId && (j.status === "running" || j.status === "processing")) return true;
  }
  return false;
}

function scheduleForget(job) {
  setTimeout(() => {
    if (jobs.get(job.publicId) === job && !["running", "processing", "paused"].includes(job.status)) {
      jobs.delete(job.publicId);
    }
  }, MEMORY_TTL_MS).unref();
}

function audit(job, action, extra = {}, result = "success") {
  const c = counts(job);
  void logAudit({
    userId: job.userId,
    action,
    entityType: "loader_job",
    result,
    description: undefined,
    metadata: { job: job.publicId, template: job.templateName, mode: job.mode, awb_total: c.total, awb_success: c.success, awb_failed: c.failed, ...extra },
  });
}

/**
 * Starts an API-mode job (returns immediately; work continues in background).
 * Caller has validated input, run the pre-check and checked permissions.
 */
async function startApiJob({ userId, table, templateName, ids, wilayah, wilayahLabel = null, sender = null, locale = "id", reference, kotaMap, hubs = [], awbs, credentials, precheck, convertWeight = true, client = lookupAwb, queueOptions }) {
  if (hasActiveJob(userId)) {
    const e = new Error("You already have a loader recheck job running. Wait for it to finish or cancel it.");
    e.status = 409;
    e.code = "JOB_ALREADY_RUNNING";
    throw e;
  }
  const job = {
    publicId: newId(),
    userId,
    mode: "api",
    status: "running",
    table,
    templateName,
    recheckedName: null,
    ids,
    wilayah,
    wilayahLabel,
    sender,
    locale,
    reference,
    kotaMap,
    hubs,
    convertWeight: convertWeight !== false,
    awbs,
    awbByKey: new Map(awbs.map((a) => [a.key, a.awb])),
    results: new Map(),
    credentials,
    client,
    queueOptions: queueOptions || {
      concurrency: config.loader.recheckConcurrency,
      delayMs: config.loader.recheckDelayMs,
      maxRetries: config.loader.recheckMaxRetries,
    },
    cancelRequested: false,
    totalRows: table.rows.length,
    precheck,
    report: null,
    download: null,
    summary: null,
    error: null,
    startedAt: new Date().toISOString(),
    lastPersist: 0,
  };
  jobs.set(job.publicId, job);
  await insertJobRow(job);
  audit(job, "loader.job_started", { awb_total: awbs.length, convert_weight: job.convertWeight });
  job.done = runJob(job);
  return job;
}

async function runJob(job) {
  job.status = "running";
  job.error = null;
  job.cancelRequested = false;
  await persistJob(job);

  const pending = job.awbs.filter((a) => !job.results.has(a.key));
  const keyByAwb = new Map(pending.map((a) => [a.awb, a.key]));
  let outcome;
  try {
    outcome = await runRecheckQueue({
      awbs: pending.map((a) => a.awb),
      credentials: job.credentials,
      client: job.client,
      options: job.queueOptions,
      shouldStop: () => job.cancelRequested,
      onResult: (awb, res) => {
        job.results.set(keyByAwb.get(awb), res);
        if (Date.now() - job.lastPersist > PERSIST_EVERY_MS) void persistJob(job);
      },
    });
  } finally {
    job.credentials = null; // token never outlives the queue run
  }

  if (outcome.stopped === "auth") {
    job.status = "paused";
    job.error = { code: "SICEPAT_AUTH", message: outcome.authMessage || "Authorization failed — token is invalid or expired." };
    await persistJob(job);
    audit(job, "loader.job_paused", { reason: "sicepat_token_rejected", upstream_status: outcome.authStatus }, "failure");
    return;
  }
  if (outcome.stopped === "cancelled") {
    job.status = "cancelled";
    await persistJob(job, { final: true });
    audit(job, "loader.job_cancelled");
    scheduleForget(job);
    return;
  }

  job.status = "processing";
  await persistJob(job);
  try {
    const rechecked = new Map();
    for (const [key, r] of job.results) if (r.status === "success") rechecked.set(key, r.phone);
    const { byCode, failures } = failureSummary(job);
    const c = counts(job);
    const recheck = { mode: "api", total: c.total, success: c.success, failed: c.failed, byCode, failures };
    const out = await buildLoaderFile({
      table: job.table,
      templateName: job.templateName,
      rechecked,
      recheckedMeta: { mode: "api", name: "SiCepat API", rows: c.total, duplicates: 0 },
      ids: job.ids,
      wilayah: job.wilayah,
      reference: job.reference,
      kotaMap: job.kotaMap,
      hubs: job.hubs,
      convertWeight: job.convertWeight,
      sender: job.sender,
      locale: job.locale,
    });
    job.download = storeResult(job.userId, out.buffer, out.filename);
    job.report = { ...out.report, recheck };
    job.summary = summarize(out.report, recheck);
    job.status = "done";
    await persistJob(job, { final: true });
    audit(job, "loader.job_completed", { rows: out.report.rows, file: out.filename });
  } catch (err) {
    job.status = "failed";
    job.error = { code: err.code || "BUILD_FAILED", message: err.status && err.status < 500 ? err.message : "The loader could not process the files." };
    if (!err.status || err.status >= 500) console.error("[loader] job build failed:", err.message);
    await persistJob(job, { final: true });
    audit(job, "loader.job_failed", { reason: job.error.code }, "failure");
  } finally {
    // Free the big objects; keep the report for the owner to read.
    job.table = null;
    job.reference = null;
    job.hubs = null;
    scheduleForget(job);
  }
}

function ownJob(publicId, userId, canSeeAll) {
  const job = jobs.get(String(publicId));
  if (!job || (job.userId !== userId && !canSeeAll)) return null;
  return job;
}

/** Resume a paused job with the user's current rechecker token. */
async function resumeJob(publicId, userId, credentials) {
  const job = ownJob(publicId, userId, false);
  if (!job) return { error: 404 };
  if (job.status !== "paused") return { error: 409 };
  if (hasActiveJob(userId)) return { error: 429 };
  job.credentials = credentials;
  audit(job, "loader.job_resumed");
  job.done = runJob(job);
  return { job };
}

async function cancelJob(publicId, userId) {
  const job = ownJob(publicId, userId, false);
  if (!job) return { error: 404 };
  if (job.status === "running") {
    job.cancelRequested = true; // the queue stops at its next check
    return { job };
  }
  if (job.status === "paused") {
    job.status = "cancelled";
    job.credentials = null;
    await persistJob(job, { final: true });
    audit(job, "loader.job_cancelled");
    scheduleForget(job);
    return { job };
  }
  return { error: 409 };
}

/** File mode: one history row for a finished run. */
async function recordFileJob({ userId, templateName, recheckedName, ids, wilayah, wilayahLabel = null, report, download }) {
  const job = {
    publicId: newId(), userId, mode: "file", status: "done", templateName, recheckedName, ids, wilayah, wilayahLabel,
    totalRows: report.rows, awbs: null, results: null, download, summary: summarize(report, null), error: null,
  };
  await insertJobRow(job);
  await persistJob(job, { final: true });
  return job.publicId;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function liveView(job) {
  const c = counts(job);
  return {
    id: job.publicId,
    mode: job.mode,
    status: job.status,
    templateName: job.templateName,
    rechecked: job.recheckedName,
    wilayah: job.wilayahLabel || job.wilayah,
    totalRows: job.totalRows,
    progress: c,
    startedAt: job.startedAt,
    error: job.error,
    report: job.report,
    download: job.download && results.has(job.download.id) ? job.download : null,
    precheck: job.precheck ? { counts: job.precheck.counts, warnings: job.precheck.warnings.map((w) => ({ code: w.code, count: w.count })) } : null,
  };
}

function rowView(r) {
  let summary = null;
  try {
    summary = r.summary ? (typeof r.summary === "string" ? JSON.parse(r.summary) : r.summary) : null;
  } catch (_) {}
  const downloadAvailable = r.download_id && results.has(r.download_id);
  return {
    id: r.public_id,
    mode: r.mode,
    status: r.status,
    templateName: r.template_name,
    rechecked: r.rechecked_name,
    wilayah: r.wilayah,
    user: r.username || null,
    totalRows: Number(r.total_rows),
    progress: { total: Number(r.total_awb), processed: Number(r.processed_awb), success: Number(r.success_awb), failed: Number(r.failed_awb) },
    startedAt: r.started_at_ts ? new Date(Number(r.started_at_ts) * 1000).toISOString() : null,
    finishedAt: r.finished_at_ts ? new Date(Number(r.finished_at_ts) * 1000).toISOString() : null,
    error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
    summary,
    download: downloadAvailable ? { id: r.download_id, filename: r.output_filename, expiresAt: new Date(results.get(r.download_id).expiresAt).toISOString() } : null,
  };
}

const ROW_SELECT = `SELECT j.*, u.username, UNIX_TIMESTAMP(j.started_at) AS started_at_ts, UNIX_TIMESTAMP(j.finished_at) AS finished_at_ts
                      FROM loader_jobs j LEFT JOIN users u ON u.id = j.user_id`;

async function getJobView(publicId, { userId, canSeeAll }) {
  const live = ownJob(publicId, userId, canSeeAll);
  if (live) return liveView(live);
  try {
    const [row] = await query(`${ROW_SELECT} WHERE j.public_id = ? LIMIT 1`, [String(publicId)]);
    if (!row || (Number(row.user_id) !== userId && !canSeeAll)) return null;
    return rowView(row);
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

async function listJobs({ userId, all, limit = 20 }) {
  let rows = [];
  try {
    rows = await query(
      `${ROW_SELECT} ${all ? "" : "WHERE j.user_id = ?"} ORDER BY j.id DESC LIMIT ?`,
      all ? [Math.min(100, limit)] : [userId, Math.min(100, limit)]
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return rows.map((r) => {
    const live = jobs.get(r.public_id);
    return live ? { ...liveView(live), user: r.username || null, report: undefined } : rowView(r);
  });
}

module.exports = {
  storeResult,
  getResult,
  startApiJob,
  resumeJob,
  cancelJob,
  recordFileJob,
  getJobView,
  listJobs,
  markInterruptedJobs,
  hasActiveJob,
  _jobs: jobs, // tests
};
