"use strict";

/**
 * Master Data — CRUD, search/filter/pagination and Excel import for the 3PL
 * Loader reference tables. The loader only READS these tables, straight from
 * the DB on every run (no cache), so a change here is used by the very next
 * loader run without a server restart.
 *
 *   hubs          loader_hub_kota      gerai / HUB → KOTA PENERIMA   entity gerai_kota_mapping
 *   kota-wilayah  loader_kota_wilayah  Kota_Tujuan → wilayah         entity kota_wilayah_mapping
 *   kodepos       kebutuhan_loader     kecamatan → kodepos           entity kodepos_reference
 *
 * Validation is pure (validate*), so it is unit-tested without a DB
 * (tests/test-master-data.js). Auditing is done by the route layer with the
 * before/after snapshots returned here. None of these tables holds recipient
 * phone numbers, so the snapshots never contain any.
 */

const { query } = require("../db");
const { readTable } = require("../loader/excel");
const { keyOf: kecKey, parseMasterWorkbook, upsertReference } = require("../loader/kodepos");
const { parseDatahub, importHubs, keyOf: hubKey } = require("../loader/hubs");

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_TEXT = 150;

class MasterDataError extends Error {
  constructor(message, status = 400, code = "INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = (message, code) => new MasterDataError(message, 400, code);

function text(value, max = MAX_TEXT) {
  return String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}
const orNull = (s) => (s ? s : null);
const kotaKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// --- pure validators ------------------------------------------------------------------

/** gerai / HUB row. KOTA PENERIMA / NAMA PENGIRIM may be empty (= loader fallback / default). */
function validateHub(input) {
  const i = input || {};
  const hub = text(i.hub);
  if (hub.length < 3) throw invalid("HUB name must be at least 3 characters.", "HUB_INVALID");
  const analytic = text(i.analytic_code, 30).toUpperCase();
  if (analytic && !/^[A-Z0-9]+$/.test(analytic)) {
    throw invalid("Analytic code may only contain letters and digits (max 30).", "ANALYTIC_CODE_INVALID");
  }
  return {
    hub,
    hub_key: hubKey(hub),
    analytic_code: orNull(analytic),
    city: orNull(text(i.city, 100)),
    dest_code: orNull(text(i.dest_code, 20).toUpperCase()),
    hub_type: orNull(text(i.hub_type, 30).toUpperCase()),
    kota_penerima: orNull(text(i.kota_penerima)),
    nama_pengirim: orNull(text(i.nama_pengirim)),
  };
}

/** Kota_Tujuan → wilayah. `knownWilayah` = wilayah present in the kodepos reference. */
function validateKotaWilayah(input, knownWilayah) {
  const i = input || {};
  const kota = text(i.kota);
  if (kota.length < 3 || !kotaKey(kota)) throw invalid("Kota_Tujuan must be at least 3 characters.", "KOTA_INVALID");
  const wanted = text(i.wilayah, 100);
  if (!wanted) throw invalid("Wilayah is required.", "WILAYAH_REQUIRED");
  const match = (knownWilayah || []).find((w) => kotaKey(w) === kotaKey(wanted));
  if (!match) throw invalid("Unknown wilayah — it must exist in the kodepos reference.", "WILAYAH_UNKNOWN");
  return { kota, kota_key: kotaKey(kota), wilayah: match };
}

/** kecamatan → kodepos reference row. */
function validateKodepos(input) {
  const i = input || {};
  const wilayah = text(i.wilayah, 100).toUpperCase();
  if (!wilayah) throw invalid("Wilayah is required.", "WILAYAH_REQUIRED");
  const kecamatan = text(i.kecamatan);
  if (kecamatan.length < 2 || !kecKey(kecamatan)) throw invalid("Kecamatan must be at least 2 characters.", "KECAMATAN_INVALID");
  const kodepos = String(i.kodepos === null || i.kodepos === undefined ? "" : i.kodepos).replace(/\D/g, "");
  if (!/^\d{5}$/.test(kodepos)) throw invalid("Kodepos must be 5 digits.", "KODEPOS_INVALID");
  return { wilayah, kecamatan, kodepos };
}

// --- entity definitions --------------------------------------------------------------------

const ENTITIES = {
  hubs: {
    entityType: "gerai_kota_mapping",
    label: "gerai/HUB → KOTA PENERIMA",
    table: "loader_hub_kota",
    select: `SELECT x.id, x.hub, x.analytic_code, x.city, x.dest_code, x.hub_type, x.kota_penerima,
                    x.nama_pengirim, x.source, x.updated_at, u.username AS updated_by
               FROM loader_hub_kota x LEFT JOIN users u ON u.id = x.updated_by`,
    search: ["x.hub", "x.analytic_code", "x.city", "x.kota_penerima", "x.nama_pengirim"],
    filters: {
      city: (v) => ({ sql: "x.city = ?", params: [v] }),
      missingLabel: (v) => (v === "1" || v === "true" ? { sql: "(x.kota_penerima IS NULL OR x.kota_penerima = '')", params: [] } : null),
    },
    order: "x.city, x.hub",
    snapshot: (r) => pick(r, ["hub", "analytic_code", "city", "dest_code", "hub_type", "kota_penerima", "nama_pengirim"]),
    recordKey: (r) => r.hub,
    async prepare(input) {
      return { ...validateHub(input), source: "manual" };
    },
    async importFile(buffer, name, userId) {
      const parsed = parseDatahub(buffer, name);
      const r = await importHubs(parsed.hubs, userId);
      return { rows: r.rows, inserted: r.inserted, updated: r.updated, skipped: [], sheet: parsed.sheetName };
    },
  },

  "kota-wilayah": {
    entityType: "kota_wilayah_mapping",
    label: "Kota_Tujuan → wilayah",
    table: "loader_kota_wilayah",
    select: `SELECT x.id, x.kota, x.wilayah, x.source, x.updated_at, u.username AS updated_by
               FROM loader_kota_wilayah x LEFT JOIN users u ON u.id = x.updated_by`,
    search: ["x.kota", "x.wilayah"],
    filters: { wilayah: (v) => ({ sql: "x.wilayah = ?", params: [v] }) },
    order: "x.wilayah, x.kota",
    snapshot: (r) => pick(r, ["kota", "wilayah"]),
    recordKey: (r) => r.kota,
    async prepare(input) {
      return { ...validateKotaWilayah(input, await knownWilayah()), source: "manual" };
    },
    async importFile(buffer, name, userId) {
      const table = readTable(buffer, name, ["Wilayah"]);
      const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z]/g, "");
      const ki = table.headers.findIndex((h) => ["kotatujuan", "kota"].includes(norm(h)));
      const wi = table.headers.findIndex((h) => norm(h) === "wilayah");
      if (ki < 0) throw invalid("The file needs the columns Kota_Tujuan and Wilayah.", "KOTA_WILAYAH_COLUMNS");
      const known = await knownWilayah();
      let inserted = 0;
      let updated = 0;
      const skipped = [];
      const seen = new Set();
      for (let n = 0; n < table.rows.length; n++) {
        const r = table.rows[n];
        if (!text(r[ki]) && !text(r[wi])) continue;
        let row;
        try {
          row = validateKotaWilayah({ kota: r[ki], wilayah: r[wi] }, known);
        } catch (err) {
          if (skipped.length < 200) skipped.push({ row: table.rowNumbers[n], value: text(r[ki]), reason: err.code });
          continue;
        }
        if (seen.has(row.kota_key)) continue;
        seen.add(row.kota_key);
        const [existing] = await query("SELECT id, wilayah FROM loader_kota_wilayah WHERE kota_key = ?", [row.kota_key]);
        if (existing) {
          if (existing.wilayah !== row.wilayah) {
            await query("UPDATE loader_kota_wilayah SET kota = ?, wilayah = ?, source = 'import', updated_by = ? WHERE id = ?", [row.kota, row.wilayah, userId || null, existing.id]);
            updated++;
          }
        } else {
          await query("INSERT INTO loader_kota_wilayah (kota, kota_key, wilayah, source, updated_by) VALUES (?, ?, ?, 'import', ?)", [row.kota, row.kota_key, row.wilayah, userId || null]);
          inserted++;
        }
      }
      return { rows: seen.size + skipped.length, inserted, updated, skipped, sheet: table.sheetName };
    },
  },

  kodepos: {
    entityType: "kodepos_reference",
    label: "kodepos reference",
    table: "kebutuhan_loader",
    select: "SELECT x.id, x.wilayah, x.kecamatan, x.kodepos, x.updated_at FROM kebutuhan_loader x",
    search: ["x.kecamatan", "x.kodepos", "x.wilayah"],
    filters: { wilayah: (v) => ({ sql: "x.wilayah = ?", params: [v] }) },
    order: "x.wilayah, x.kecamatan, x.kodepos",
    snapshot: (r) => pick(r, ["wilayah", "kecamatan", "kodepos"]),
    recordKey: (r) => `${r.wilayah} / ${r.kecamatan} / ${r.kodepos}`,
    async prepare(input) {
      return validateKodepos(input);
    },
    async importFile(buffer) {
      let parsed;
      try {
        parsed = parseMasterWorkbook(buffer);
      } catch (_) {
        throw invalid("The file could not be read as Excel.", "UNREADABLE_FILE");
      }
      if (!parsed.rows.length) {
        throw invalid("No kecamatan/kodepos rows were found. Each sheet needs a header row: Kecamatan | Kode Pos.", "KODEPOS_EMPTY");
      }
      const r = await upsertReference(parsed.rows);
      return { rows: parsed.rows.length, inserted: r.inserted, updated: 0, skipped: [], sheet: parsed.sheets.map((s) => s.wilayah).join(", ") };
    },
  },
};

function pick(row, keys) {
  const out = {};
  for (const k of keys) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

function entityOf(name) {
  const e = ENTITIES[name];
  if (!e) throw new MasterDataError("Unknown master data entity.", 404, "ENTITY_UNKNOWN");
  return e;
}

async function knownWilayah() {
  return (await query("SELECT DISTINCT wilayah FROM kebutuhan_loader WHERE wilayah IS NOT NULL ORDER BY wilayah")).map((r) => r.wilayah);
}

function pageParams(q) {
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(q.pageSize)) || DEFAULT_PAGE_SIZE));
  return { page, pageSize };
}

/** Search + filters + pagination. Returns { rows, total, page, pageSize }. */
async function list(name, q = {}) {
  const e = entityOf(name);
  const where = [];
  const params = [];
  const search = text(q.search, 100);
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    where.push(`(${e.search.map((c) => `${c} LIKE ?`).join(" OR ")})`);
    params.push(...e.search.map(() => term));
  }
  for (const [key, build] of Object.entries(e.filters)) {
    if (q[key] === undefined || q[key] === "") continue;
    const f = build(text(q[key], 100));
    if (!f) continue;
    where.push(f.sql);
    params.push(...f.params);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const { page, pageSize } = pageParams(q);
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM ${e.table} x${whereSql}`, params);
  const rows = await query(`${e.select}${whereSql} ORDER BY ${e.order} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { rows, total: Number(n), page, pageSize };
}

async function getRow(e, id) {
  const [row] = await query(`${e.select} WHERE x.id = ?`, [Number(id)]);
  return row || null;
}

function duplicate(err) {
  return err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);
}

/** @returns {{ id, before: null, after, recordKey }} */
async function create(name, input, userId) {
  const e = entityOf(name);
  const data = await e.prepare(input);
  const cols = Object.keys(data);
  if (e.table !== "kebutuhan_loader") cols.push("updated_by");
  const values = cols.map((c) => (c === "updated_by" ? userId || null : data[c]));
  let res;
  try {
    res = await query(`INSERT INTO ${e.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
  } catch (err) {
    if (duplicate(err)) throw new MasterDataError("A record with the same key already exists.", 409, "DUPLICATE");
    throw err;
  }
  const row = await getRow(e, res.insertId);
  return { id: Number(res.insertId), before: null, after: e.snapshot(row), recordKey: e.recordKey(row), row };
}

/** @returns {{ id, before, after, recordKey }} */
async function update(name, id, input, userId) {
  const e = entityOf(name);
  const current = await getRow(e, id);
  if (!current) throw new MasterDataError("Record not found.", 404, "NOT_FOUND");
  const data = await e.prepare(input);
  const sets = Object.keys(data).map((c) => `${c} = ?`);
  const values = Object.values(data);
  if (e.table !== "kebutuhan_loader") {
    sets.push("updated_by = ?");
    values.push(userId || null);
  }
  try {
    await query(`UPDATE ${e.table} SET ${sets.join(", ")} WHERE id = ?`, [...values, Number(id)]);
  } catch (err) {
    if (duplicate(err)) throw new MasterDataError("A record with the same key already exists.", 409, "DUPLICATE");
    throw err;
  }
  const row = await getRow(e, id);
  return { id: Number(id), before: e.snapshot(current), after: e.snapshot(row), recordKey: e.recordKey(row), row };
}

/** @returns {{ id, before, after: null, recordKey }} */
async function remove(name, id) {
  const e = entityOf(name);
  const current = await getRow(e, id);
  if (!current) throw new MasterDataError("Record not found.", 404, "NOT_FOUND");
  await query(`DELETE FROM ${e.table} WHERE id = ?`, [Number(id)]);
  return { id: Number(id), before: e.snapshot(current), after: null, recordKey: e.recordKey(current) };
}

async function importFile(name, buffer, fileName, userId) {
  return entityOf(name).importFile(buffer, fileName, userId);
}

function isMissingTable(err) {
  return err && (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146);
}

module.exports = {
  ENTITIES,
  MasterDataError,
  validateHub,
  validateKotaWilayah,
  validateKodepos,
  entityOf,
  knownWilayah,
  pageParams,
  list,
  create,
  update,
  remove,
  importFile,
  isMissingTable,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
