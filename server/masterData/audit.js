"use strict";

/**
 * Master Data audit trail — write helper + read query.
 *
 * Storage: the shared audit table storage_audit_logs (via logAudit), so these
 * events also appear in the global Audit Trail under module "master_data":
 *   action       master_data.create | .update | .delete | .import
 *   entity_type  gerai_kota_mapping | kota_wilayah_mapping | kodepos_reference
 *   entity_id    record id (none for an import)
 *   metadata     v2 envelope: before / after JSON snapshots, actor, details
 *                { entity, entity_label, record_key, file … }
 *   user_id, created_at
 * Snapshots hold reference values only (hub, kota, kodepos …) — never phone numbers.
 */

const { query } = require("../db");
const { logAudit, normalizeRecord } = require("../audit");

const ACTIONS = { CREATE: "master_data.create", UPDATE: "master_data.update", DELETE: "master_data.delete", IMPORT: "master_data.import" };
const ENTITY_TYPES = [
  "gerai_kota_mapping", "kota_wilayah_mapping", "kodepos_reference",
  "master_wilayah", "master_cust_id", "master_wilayah_kota", // migration 014
];
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** "master_data.update" → "UPDATE" */
function actionCode(action) {
  const hit = Object.entries(ACTIONS).find(([, a]) => a === action);
  return hit ? hit[0] : String(action || "").toUpperCase();
}

/** Writes one Master Data audit row. */
function record({ req, code, entity, entityKey, id = null, before = null, after = null, details = {} }) {
  return logAudit({
    req,
    action: ACTIONS[code],
    entityType: entity.entityType,
    entityId: id,
    before,
    after,
    metadata: { entity: entityKey, entity_label: entity.label, ...details },
  });
}

class AuditQueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const SELECT = `
  SELECT a.id, a.user_id, a.action, a.entity_type, a.entity_id, a.metadata,
         a.ip_address, UNIX_TIMESTAMP(a.created_at) AS created_at_ts,
         u.username AS cur_username, u.full_name AS cur_full_name, NULL AS cur_roles
    FROM storage_audit_logs a
    LEFT JOIN users u ON u.id = a.user_id`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filters: entityType, action (CREATE|UPDATE|DELETE|IMPORT), from / to
 * (YYYY-MM-DD, inclusive, compared in SQL in DB time), search (record key /
 * user), page, pageSize. Newest first.
 */
async function listAudit(q = {}) {
  const where = ["a.action LIKE 'master\\_data.%'"];
  const params = [];
  if (q.entityType) {
    if (!ENTITY_TYPES.includes(q.entityType)) throw new AuditQueryError("Invalid entity type.");
    where.push("a.entity_type = ?");
    params.push(q.entityType);
  }
  if (q.action) {
    const action = ACTIONS[String(q.action).toUpperCase()];
    if (!action) throw new AuditQueryError("Invalid action.");
    where.push("a.action = ?");
    params.push(action);
  }
  for (const [key, op] of [["from", ">="], ["to", "<"]]) {
    if (!q[key]) continue;
    if (!DATE_RE.test(String(q[key]))) throw new AuditQueryError("Dates must be YYYY-MM-DD.");
    where.push(op === ">=" ? "a.created_at >= ?" : "a.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(String(q[key]));
  }
  const search = String(q.search || "").trim().slice(0, 100);
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    where.push("(a.metadata LIKE ? OR u.username LIKE ?)");
    params.push(term, term);
  }
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(q.pageSize)) || DEFAULT_PAGE_SIZE));
  const whereSql = ` WHERE ${where.join(" AND ")}`;
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM storage_audit_logs a LEFT JOIN users u ON u.id = a.user_id${whereSql}`, params);
  const rows = await query(`${SELECT}${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { records: rows.map(toEntry), total: Number(n), page, pageSize };
}

/** Audit row → the Master Data history entry shown in the UI. */
function toEntry(row) {
  const r = normalizeRecord(row, { full: true });
  const details = r.details || {};
  return {
    id: r.id,
    created_at: r.created_at,
    action: actionCode(r.action),
    entity_type: r.entity_type,
    entity: details.entity || null,
    record_id: r.entity_id,
    record_key: details.record_key || null,
    before: r.before === undefined ? null : r.before,
    after: r.after === undefined ? null : r.after,
    details: { file: details.file || null, sheet: details.sheet || null },
    actor: { id: r.actor.id, username: r.actor.username, full_name: r.actor.full_name },
    result: r.result,
  };
}

module.exports = { ACTIONS, ENTITY_TYPES, actionCode, record, listAudit, toEntry, AuditQueryError };
