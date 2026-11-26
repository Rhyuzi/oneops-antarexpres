"use strict";

/**
 * Master Data API — the ONLY place where the loader reference tables change.
 * Mounted in server/index.js: /api/master-data behind requireAuth +
 * requirePermission("master_data.view") (+ a 30 MB JSON body for imports).
 *
 *   GET    /meta                       master_data.view    { wilayah, entities }
 *   GET    /audit                      master_data.audit   ?entityType&action&from&to&search&page&pageSize
 *   GET    /:entity                    master_data.view    ?search&page&pageSize (+ hubs: city, missingLabel; kodepos/kota-wilayah: wilayah)
 *   POST   /:entity                    master_data.manage  create
 *   PUT    /:entity/:id                master_data.manage  update
 *   DELETE /:entity/:id                master_data.manage  delete
 *   POST   /:entity/import             master_data.manage  { file: { name, data(base64) } }
 *
 *   :entity = hubs | kota-wilayah | kodepos | wilayah | cust-id | wilayah-kota
 *   (wilayah / cust-id / wilayah-kota: migration 014, FK wilayah_id; no import;
 *    cust-id + wilayah-kota filter by ?wilayahId)
 *
 * Every mutation writes an audit row (master_data.create|update|delete|import)
 * with before/after snapshots — see server/masterData/audit.js. The 3PL
 * Loader reads these tables on every run, so changes apply immediately.
 */

const express = require("express");
const { requirePermission } = require("../modulePermissions");
const md = require("../masterData/service");
const mdAudit = require("../masterData/audit");

const router = express.Router();
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function fail(res, err) {
  if (md.isMissingTable(err)) {
    return res.status(503).json({ ok: false, code: "TABLE_MISSING", message: "A reference table is missing. Run database migrations 010–014." });
  }
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error("[master-data]", err.dbMessage || err.message);
  return res.status(status).json({
    ok: false,
    code: err.code && status < 500 ? err.code : undefined,
    message: status >= 500 ? "Master data request failed." : err.message,
  });
}

function decodeFile(input) {
  if (!input || typeof input !== "object" || typeof input.data !== "string" || !input.data) {
    throw new md.MasterDataError("An Excel file is required.", 400, "FILE_REQUIRED");
  }
  const name = String(input.name || "upload.xlsx").slice(0, 200);
  if (!/\.(xlsx|xls)$/i.test(name)) throw new md.MasterDataError("Only .xlsx or .xls files are supported.", 400, "FILE_TYPE");
  const buffer = Buffer.from(input.data, "base64");
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new md.MasterDataError("The file is empty or larger than 10 MB.", 400, "FILE_SIZE");
  return { name, buffer };
}

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new md.MasterDataError("Record not found.", 404, "NOT_FOUND");
  return id;
}

router.get("/meta", async (_req, res) => {
  try {
    return res.json({
      ok: true,
      wilayah: await md.knownWilayah(),
      // master_wilayah choices (Cust ID / kota forms + filters). Empty before migration 014.
      masterWilayah: await md.masterWilayahOptions().catch((err) => {
        if (md.isMissingTable(err)) return [];
        throw err;
      }),
      entities: Object.entries(md.ENTITIES).map(([key, e]) => ({ key, entityType: e.entityType, importable: e.importable !== false })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// Before "/:entity" so "audit" is never taken for an entity name.
router.get("/audit", requirePermission("master_data.audit"), async (req, res) => {
  try {
    return res.json({ ok: true, ...(await mdAudit.listAudit(req.query)) });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/:entity", async (req, res) => {
  try {
    return res.json({ ok: true, ...(await md.list(req.params.entity, req.query)) });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/:entity/import", requirePermission("master_data.manage"), async (req, res) => {
  try {
    const entity = md.entityOf(req.params.entity);
    const file = decodeFile((req.body || {}).file);
    const result = await md.importFile(req.params.entity, file.buffer, file.name, req.user.id);
    await mdAudit.record({
      req,
      code: "IMPORT",
      entity,
      entityKey: req.params.entity,
      after: { rows: result.rows, inserted: result.inserted, updated: result.updated, skipped: result.skipped.length },
      details: { file: file.name, sheet: result.sheet },
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/:entity", requirePermission("master_data.manage"), async (req, res) => {
  try {
    const entity = md.entityOf(req.params.entity);
    const r = await md.create(req.params.entity, req.body || {}, req.user.id);
    await mdAudit.record({ req, code: "CREATE", entity, entityKey: req.params.entity, id: r.id, after: r.after, details: { record_key: r.recordKey } });
    return res.status(201).json({ ok: true, id: r.id, row: r.row });
  } catch (err) {
    return fail(res, err);
  }
});

router.put("/:entity/:id", requirePermission("master_data.manage"), async (req, res) => {
  try {
    const entity = md.entityOf(req.params.entity);
    const r = await md.update(req.params.entity, idParam(req), req.body || {}, req.user.id);
    await mdAudit.record({ req, code: "UPDATE", entity, entityKey: req.params.entity, id: r.id, before: r.before, after: r.after, details: { record_key: r.recordKey } });
    return res.json({ ok: true, id: r.id, row: r.row });
  } catch (err) {
    return fail(res, err);
  }
});

router.delete("/:entity/:id", requirePermission("master_data.manage"), async (req, res) => {
  try {
    const entity = md.entityOf(req.params.entity);
    const r = await md.remove(req.params.entity, idParam(req));
    await mdAudit.record({ req, code: "DELETE", entity, entityKey: req.params.entity, id: r.id, before: r.before, details: { record_key: r.recordKey } });
    return res.json({ ok: true, id: r.id });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
