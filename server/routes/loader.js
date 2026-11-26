"use strict";

/**
 * Automation Loader Kodepos API.
 * Mounted in server/index.js behind requireAuth + requirePermission("loader.view").
 *
 * Phone source — two modes:
 *   FILE  POST /api/loader/process            loader.run
 *         body { template, rechecked, wilayahId, kotaId, acknowledgeWarnings?,
 *                convertWeightFromActual? (default true — Rule 4 switch) }
 *         → { report, download, jobId }   (synchronous)
 *   API   POST /api/loader/jobs               loader.run + loader.recheck
 *         body { template, wilayahId, kotaId, acknowledgeWarnings?,
 *                convertWeightFromActual?,
 *                sicepatUserId }
 *         headers: Authorization: Bearer <SiCepat token>, x-permission-token
 *         (the SAME token the user manages in the rechecker settings — never
 *         stored by OneOps). Runs the pre-check first; returns the job.
 *         GET  /api/loader/jobs                 history (own; all with loader.manage_settings)
 *         GET  /api/loader/jobs/:id             progress / report / download
 *         POST /api/loader/jobs/:id/resume      loader.recheck (fresh token headers)
 *         POST /api/loader/jobs/:id/cancel      loader.run
 *   POST /api/loader/precheck                   loader.run — body { template, wilayahId }
 *
 * wilayahId / kotaId refer to Master Data (migration 014). The server reads
 * the Cust IDs (N / Y), the kodepos scope and KOTA / NAMA PENGIRIM from the
 * DB (server/loader/wilayah.js) — the client never supplies Cust IDs.
 *   GET  /api/loader/download/:id               loader.run — .xlsx attachment, owner only
 *
 * Reference + settings:
 * Reference data — READ-ONLY here (all changes: /api/master-data, routes/masterData.js):
 *   GET  /api/loader/reference/summary | /reference         loader.view
 *   GET  /api/loader/settings/kota-wilayah                  loader.view
 *   GET  /api/loader/settings/hubs                          loader.view (gerai/HUB → KOTA PENERIMA)
 *   GET  /api/loader/wilayah-options                        loader.view (wilayah → cust IDs + kota)
 *
 * Files travel as base64 in JSON (no multipart dependency).
 */

const express = require("express");
const { query } = require("../db");
const { requirePermission } = require("../modulePermissions");
const { logAudit } = require("../audit");
const { credentialsFromRequest } = require("../recheck/sicepatClient");
const { config } = require("../config");
const service = require("../loader/service");
const { precheckTemplate, uniqueResiList } = require("../loader/precheck");
const settings = require("../loader/settings");
const hubs = require("../loader/hubs");
const jobs = require("../loader/jobs");
const wilayahMaster = require("../loader/wilayah");
const { localeOf } = require("../loader/resiIssues");

const router = express.Router();

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fail(res, err) {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error("[loader]", err.dbMessage || err.message);
  if (settings.isMissingTable(err) && /master_(wilayah|cust_id)/.test(String(err.sqlMessage || err.dbMessage || err.message))) {
    return res.status(503).json({
      ok: false,
      message: "The wilayah master is not installed. Run database/migrations/014_master_wilayah.sql.",
    });
  }
  if (settings.isMissingTable(err)) {
    return res.status(503).json({
      ok: false,
      message: "The kodepos reference table is not installed. Run database/migrations/010_kebutuhan_loader.sql.",
    });
  }
  return res.status(status).json({
    ok: false,
    message: status >= 500 ? "The loader could not process the files." : err.message,
    ...(err.code && status < 500 ? { code: err.code } : {}),
    ...(err.details && status < 500 ? { details: err.details } : {}),
  });
}

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}
const badRequest = (message, code) => httpError(400, message, code);

/** Validates { name, data(base64) } and returns { name, buffer }. */
function decodeFile(input, label) {
  if (!input || typeof input !== "object" || typeof input.data !== "string" || !input.data) {
    throw badRequest(`The ${label} file is required.`);
  }
  const name = String(input.name || `${label}.xlsx`).slice(0, 200);
  if (!/\.(xlsx|xls)$/i.test(name)) throw badRequest(`The ${label} file must be an .xlsx or .xls file.`);
  const buffer = Buffer.from(input.data, "base64");
  if (!buffer.length) throw badRequest(`The ${label} file is empty.`);
  if (buffer.length > MAX_FILE_BYTES) throw badRequest(`The ${label} file exceeds the 10 MB limit.`);
  return { name, buffer };
}

/** "Tasikmalaya / Sukaraja" — job history label (no customer data). */
const contextLabel = (ctx) => [ctx.wilayah.name, ctx.kota && ctx.kota.kota].filter(Boolean).join(" / ");
const canSeeAll = (req) => req.user.roles.includes("super_admin") || (req.user.permissions && req.user.permissions.has("loader.manage_settings"));

/** Short summary for the audit trail (no customer data). */
function auditSummary(report) {
  return {
    template: report.template && report.template.name,
    rechecked: report.rechecked && report.rechecked.name,
    rows: report.rows,
    cod: report.cod,
    non_cod: report.nonCod,
    convert_weight: report.weight.conversion !== false,
    weight_normalized: report.weight.normalized,
    kodepos_filled: report.kodepos.filled,
    kodepos_missing: report.kodepos.missing.length,
    kodepos_ambiguous: report.kodepos.ambiguous.length,
    phones_from_rechecked: report.phone.fromRechecked,
    phones_invalid: report.phone.invalid.length,
    unknown_cod: report.unknownCod.length,
    kota_penerima_fallback: report.kotaPenerima ? report.kotaPenerima.fallback : 0,
    empty_cells: report.empty ? report.empty.cells : 0,
    duplicate_resi: report.duplicateResi ? report.duplicateResi.groups : 0,
  };
}

// --- file mode (two files) -------------------------------------------------------

router.post("/process", requirePermission("loader.run"), async (req, res) => {
  try {
    const body = req.body || {};
    // Wilayah + kota → Cust IDs, kodepos scope and sender columns, all from
    // Master Data. Cust IDs sent by the client are ignored (read-only in the UI).
    const ctx = await wilayahMaster.resolveLoaderContext(body);
    const template = decodeFile(body.template, "template");
    const rechecked = decodeFile(body.rechecked, "rechecked");

    const out = await service.processLoader({
      templateBuffer: template.buffer,
      templateName: template.name,
      recheckedBuffer: rechecked.buffer,
      recheckedName: rechecked.name,
      custIdCod: ctx.ids.cod,
      custIdNonCod: ctx.ids.nonCod,
      wilayah: ctx.kodeposWilayah,
      convertWeight: service.convertWeightOf(body),
      sender: ctx.sender,
      // Resi double → 409 DUPLICATE_RESI (rows listed) until the operator confirms.
      acknowledgeDuplicates: body.acknowledgeWarnings === true,
      locale: localeOf(body.locale),
    });

    const download = jobs.storeResult(req.user.id, out.buffer, out.filename);
    const jobId = await jobs.recordFileJob({
      userId: req.user.id,
      templateName: template.name,
      recheckedName: rechecked.name,
      ids: ctx.ids,
      wilayah: ctx.kodeposWilayah,
      wilayahLabel: contextLabel(ctx),
      report: out.report,
      download,
    });

    await logAudit({
      req,
      action: "loader.processed",
      entityType: "loader_file",
      description: `Generated loader file "${out.filename}" (${out.report.rows} rows)`,
      after: {
        file: out.filename, rows: out.report.rows, wilayah: ctx.wilayah.name, kota: ctx.kota.kota,
        cust_id_cod: ctx.ids.cod, cust_id_non_cod: ctx.ids.nonCod,
        kota_pengirim: ctx.sender.kotaPengirim, nama_pengirim: ctx.sender.namaPengirim,
      },
      metadata: { ...auditSummary(out.report), mode: "file", job: jobId },
    });

    return res.json({ ok: true, report: out.report, download, jobId });
  } catch (err) {
    if (err.status === 400 && req.user) {
      void logAudit({
        req,
        action: "loader.process_failed",
        entityType: "loader_file",
        result: "failure",
        metadata: { reason: err.code || "invalid_input", message: String(err.message).slice(0, 200) },
      });
    }
    return fail(res, err);
  }
});

router.get("/download/:id", requirePermission("loader.run"), (req, res) => {
  const entry = jobs.getResult(req.params.id, req.user.id);
  if (!entry) {
    return res.status(404).json({ ok: false, message: "This download has expired. Process the files again." });
  }
  const ascii = entry.filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`);
  res.setHeader("Content-Length", entry.buffer.length);
  res.setHeader("Cache-Control", "no-store");
  return res.end(entry.buffer);
});

// --- pre-check -----------------------------------------------------------------------

/** Reads the template and runs the pre-check with the real lookup + mapping. */
async function runPrecheck(body, ctx = null) {
  // The pre-check only needs the kodepos scope (wilayah); the kota is checked at run time.
  const context = ctx || (await wilayahMaster.resolveLoaderContext(body, { requireKota: false }));
  const wilayah = context.kodeposWilayah;
  const template = decodeFile(body.template, "template");
  const table = service.readTemplate(template.buffer, template.name);
  const lookupData = await service.loadLookupData();
  const precheck = precheckTemplate(table, {
    lookupKodepos: service.makeLookup({ ...lookupData, wilayah }),
    lookupKotaPenerima: hubs.buildHubLookup(lookupData.hubs),
  });
  return { template, table, wilayah, lookupData, precheck, ctx: context };
}

router.post("/precheck", requirePermission("loader.run"), async (req, res) => {
  try {
    const { precheck } = await runPrecheck(req.body || {});
    return res.json({ ok: true, precheck });
  } catch (err) {
    return fail(res, err);
  }
});

// --- API mode jobs ---------------------------------------------------------------------

router.post("/jobs", requirePermission("loader.run"), requirePermission("loader.recheck"), async (req, res) => {
  try {
    const body = req.body || {};
    const ctx = await wilayahMaster.resolveLoaderContext(body);
    const ids = ctx.ids;
    const credentials = credentialsFromRequest(req, "sicepatUserId");
    if (!credentials) throw badRequest("Missing SiCepat credentials. Configure them in Settings.", "SICEPAT_CREDENTIALS_MISSING");
    if (jobs.hasActiveJob(req.user.id)) {
      throw httpError(409, "You already have a loader recheck job running. Wait for it to finish or cancel it.", "JOB_ALREADY_RUNNING");
    }

    const { template, table, wilayah, lookupData, precheck } = await runPrecheck(body, ctx);
    if (!precheck.ok) {
      return res.status(400).json({ ok: false, code: "PRECHECK_FAILED", message: "The template did not pass the pre-check.", precheck });
    }
    if (precheck.warnings.length && body.acknowledgeWarnings !== true) {
      return res.status(409).json({ ok: false, code: "PRECHECK_WARNINGS", message: "Review the pre-check warnings and confirm to continue.", precheck });
    }
    const awbs = uniqueResiList(table);
    if (awbs.length > config.loader.maxAwbPerJob) {
      throw badRequest(`Too many AWBs for one job (max ${config.loader.maxAwbPerJob}). Split the template.`, "TOO_MANY_AWB");
    }

    const job = await jobs.startApiJob({
      userId: req.user.id,
      table,
      templateName: template.name,
      ids,
      wilayah,
      wilayahLabel: contextLabel(ctx),
      sender: ctx.sender,
      locale: localeOf(body.locale),
      reference: lookupData.reference,
      kotaMap: lookupData.kotaMap,
      hubs: lookupData.hubs,
      awbs,
      credentials,
      precheck,
      convertWeight: service.convertWeightOf(body),
    });
    return res.status(202).json({ ok: true, job: await jobs.getJobView(job.publicId, { userId: req.user.id }) });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/jobs", async (req, res) => {
  try {
    const all = req.query.scope === "all" && canSeeAll(req);
    return res.json({ ok: true, jobs: await jobs.listJobs({ userId: req.user.id, all, limit: Number(req.query.limit) || 20 }) });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/jobs/:id", async (req, res) => {
  try {
    const view = await jobs.getJobView(req.params.id, { userId: req.user.id, canSeeAll: canSeeAll(req) });
    if (!view) return res.status(404).json({ ok: false, message: "Loader job not found." });
    return res.json({ ok: true, job: view });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/jobs/:id/resume", requirePermission("loader.run"), requirePermission("loader.recheck"), async (req, res) => {
  try {
    const credentials = credentialsFromRequest(req, "sicepatUserId");
    if (!credentials) throw badRequest("Missing SiCepat credentials. Configure them in Settings.", "SICEPAT_CREDENTIALS_MISSING");
    const r = await jobs.resumeJob(req.params.id, req.user.id, credentials);
    if (r.error === 404) return res.status(404).json({ ok: false, message: "Loader job not found." });
    if (r.error === 409) return res.status(409).json({ ok: false, message: "Only paused jobs can be resumed." });
    if (r.error === 429) return res.status(409).json({ ok: false, message: "You already have a loader recheck job running. Wait for it to finish or cancel it." });
    return res.json({ ok: true, job: await jobs.getJobView(req.params.id, { userId: req.user.id }) });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/jobs/:id/cancel", requirePermission("loader.run"), async (req, res) => {
  try {
    const r = await jobs.cancelJob(req.params.id, req.user.id);
    if (r.error === 404) return res.status(404).json({ ok: false, message: "Loader job not found." });
    if (r.error === 409) return res.status(409).json({ ok: false, message: "This job can no longer be cancelled." });
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

// --- reference ----------------------------------------------------------------------------

/**
 * Wilayah master for the Loader form and the read-only reference card:
 * wilayah → cust IDs (N / Y), breakdown kota, NAMA PENGIRIM base.
 * Edited only in Master Data.
 */
router.get("/wilayah-options", async (_req, res) => {
  try {
    return res.json({ ok: true, wilayah: await wilayahMaster.loadWilayahOptions() });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/reference/summary", async (_req, res) => {
  try {
    const rows = await query(
      `SELECT wilayah, COUNT(*) AS n, MAX(updated_at) AS updated_at
         FROM kebutuhan_loader GROUP BY wilayah ORDER BY wilayah`
    );
    return res.json({
      ok: true,
      total: rows.reduce((s, r) => s + Number(r.n), 0),
      wilayah: rows.map((r) => ({ wilayah: r.wilayah, count: Number(r.n), updatedAt: r.updated_at })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/reference", async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.wilayah) {
      where.push("wilayah = ?");
      params.push(String(req.query.wilayah).slice(0, 100));
    }
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    if (search) {
      where.push("(kecamatan LIKE ? OR kodepos LIKE ?)");
      const term = `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
      params.push(term, term);
    }
    const rows = await query(
      `SELECT id, wilayah, kecamatan, kodepos FROM kebutuhan_loader
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY wilayah, kecamatan LIMIT 200`,
      params
    );
    return res.json({ ok: true, rows });
  } catch (err) {
    return fail(res, err);
  }
});

// --- settings: Kota_Tujuan → wilayah -------------------------------------------------------

router.get("/settings/kota-wilayah", async (_req, res) => {
  try {
    return res.json({ ok: true, mappings: await settings.listKotaMappings(), wilayah: await settings.knownWilayah() });
  } catch (err) {
    if (settings.isMissingTable(err)) {
      return res.status(503).json({ ok: false, message: "Loader settings are not installed. Run database/migrations/011_loader_jobs_kota_wilayah.sql." });
    }
    return fail(res, err);
  }
});

// --- gerai / HUB → KOTA PENERIMA (Result 3PL) -----------------------------------------

function hubTableMissing(res) {
  return res.status(503).json({ ok: false, message: "Hub settings are not installed. Run database/migrations/012_loader_hub_kota.sql." });
}

router.get("/settings/hubs", async (_req, res) => {
  try {
    // loadHubs() returns [] without the table; report it explicitly here.
    await query("SELECT 1 FROM loader_hub_kota LIMIT 1");
    return res.json({ ok: true, hubs: await hubs.loadHubs() });
  } catch (err) {
    if (hubs.isMissingTable(err)) return hubTableMissing(res);
    return fail(res, err);
  }
});

module.exports = router;
