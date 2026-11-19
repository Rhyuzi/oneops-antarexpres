"use strict";

/**
 * Audit Trail API — READ-ONLY.
 *
 * Mounted in server/index.js behind requireAuth + requirePermission(
 * "audit_trail.view") (super_admin passes via the canonical bypass in
 * modulePermissions.js). There are intentionally no write routes: any
 * non-GET method answers 405, so audit records cannot be created, changed
 * or deleted through the API.
 *
 *   GET /api/audit-trail          list (server-side pagination + filters)
 *   GET /api/audit-trail/filters  options for the filter controls
 *   GET /api/audit-trail/:id      one record with before/after + details
 */

const express = require("express");
const { query } = require("../db");
const { MODULE_LABELS, moduleCondition, escapeLike, normalizeRecord } = require("../audit");

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const ACTION_RE = /^[a-z0-9_.]{1,60}$/;

const SELECT = `
  SELECT a.id, a.user_id, a.action, a.entity_type, a.entity_id, a.metadata,
         a.ip_address, UNIX_TIMESTAMP(a.created_at) AS created_at_ts,
         u.username AS cur_username, u.full_name AS cur_full_name,
         (SELECT GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ',')
            FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = a.user_id) AS cur_roles
    FROM storage_audit_logs a
    LEFT JOIN users u ON u.id = a.user_id`;

function fail(res, err) {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error("[audit-trail]", err.dbMessage || err.message);
  return res
    .status(status)
    .json({ ok: false, message: status >= 500 ? "Could not load the audit trail." : err.message });
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Positive integer or undefined; throws 400 on garbage. */
function intParam(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`Invalid ${name}.`);
  return n;
}

/** Epoch seconds (the browser sends local-day boundaries as epoch). */
function epochParam(value, name) {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 4102444800) throw badRequest(`Invalid ${name}.`);
  return Math.floor(n);
}

/** Builds WHERE + params from validated query parameters. */
function buildFilters(q) {
  const where = [];
  const params = [];

  const userId = intParam(q.userId, "userId");
  if (userId !== undefined) {
    where.push("a.user_id = ?");
    params.push(userId);
  }

  if (q.module) {
    const cond = moduleCondition(String(q.module));
    if (!cond) throw badRequest("Unknown module.");
    where.push(cond.sql);
    params.push(...cond.params);
  }

  if (q.action) {
    const action = String(q.action);
    if (!ACTION_RE.test(action)) throw badRequest("Invalid action.");
    where.push("a.action = ?");
    params.push(action);
  }

  if (q.result) {
    if (q.result === "failure") {
      where.push(`(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.result')) = 'failure' OR a.action LIKE '%\\_failed')`);
    } else if (q.result === "success") {
      where.push(`(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.result')), 'success') = 'success' AND a.action NOT LIKE '%\\_failed')`);
    } else {
      throw badRequest("Invalid result.");
    }
  }

  const from = epochParam(q.from, "from");
  const to = epochParam(q.to, "to");
  if (from !== undefined && to !== undefined && from > to) throw badRequest("Start date is after end date.");
  if (from !== undefined) {
    where.push("a.created_at >= FROM_UNIXTIME(?)");
    params.push(from);
  }
  if (to !== undefined) {
    where.push("a.created_at < FROM_UNIXTIME(?)");
    params.push(to);
  }

  const search = typeof q.search === "string" ? q.search.trim().slice(0, 100) : "";
  if (search) {
    const term = `%${escapeLike(search)}%`;
    const asId = /^\d+$/.test(search) ? Number(search) : null;
    where.push(`(u.username LIKE ? OR u.full_name LIKE ? OR a.action LIKE ? OR a.entity_type LIKE ?
                 OR CAST(a.metadata AS CHAR) LIKE ?${asId !== null ? " OR a.entity_id = ? OR a.id = ?" : ""})`);
    params.push(term, term, term, term, term);
    if (asId !== null) params.push(asId, asId);
  }

  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// --- list ---------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const page = intParam(req.query.page, "page", { max: 100000 }) || 1;
    const pageSize = intParam(req.query.pageSize, "pageSize", { max: MAX_PAGE_SIZE }) || DEFAULT_PAGE_SIZE;
    const { whereSql, params } = buildFilters(req.query);

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM storage_audit_logs a LEFT JOIN users u ON u.id = a.user_id ${whereSql}`,
      params
    );
    const rows = await query(
      `${SELECT} ${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    return res.json({
      ok: true,
      records: rows.map((r) => normalizeRecord(r)),
      total: Number(total),
      page,
      pageSize,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// --- filter options ---------------------------------------------------------------
router.get("/filters", async (_req, res) => {
  try {
    const actions = await query(
      "SELECT action, COUNT(*) AS n FROM storage_audit_logs GROUP BY action ORDER BY action"
    );
    const users = await query(
      `SELECT u.id, u.username, u.full_name
         FROM users u
        WHERE EXISTS (SELECT 1 FROM storage_audit_logs a WHERE a.user_id = u.id)
        ORDER BY u.username`
    );
    const { moduleOf } = require("../audit");
    const modules = Object.entries(MODULE_LABELS)
      .filter(([key]) => key !== "other")
      .map(([key, label]) => ({ key, label }));
    return res.json({
      ok: true,
      modules,
      actions: actions.map((a) => ({ action: a.action, module: moduleOf(a.action), count: Number(a.n) })),
      users: users.map((u) => ({ id: Number(u.id), username: u.username, full_name: u.full_name })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// --- detail -----------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const id = intParam(req.params.id, "id");
    if (id === undefined) throw badRequest("Invalid id.");
    const rows = await query(`${SELECT} WHERE a.id = ? LIMIT 1`, [id]);
    if (!rows[0]) return res.status(404).json({ ok: false, message: "Audit record not found." });
    return res.json({ ok: true, record: normalizeRecord(rows[0], { full: true }) });
  } catch (err) {
    return fail(res, err);
  }
});

// --- immutability -------------------------------------------------------------------
router.all(["/", "/:id", "/filters"], (req, res) => {
  res.setHeader("Allow", "GET");
  return res.status(405).json({ ok: false, message: "Audit records are read-only." });
});

module.exports = router;
