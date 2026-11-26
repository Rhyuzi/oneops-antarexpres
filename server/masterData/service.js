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
 *   wilayah       master_wilayah       wilayah (+ kodepos code, NAMA PENGIRIM base)   entity master_wilayah
 *   cust-id       master_cust_id       wilayah_id FK → Cust ID N / Y                  entity master_cust_id
 *   wilayah-kota  master_wilayah_kota  wilayah_id FK → breakdown kota (+ aliases)     entity master_wilayah_kota
 * (the last three: migration 014; deleting a wilayah that still has cust IDs
 * or kota is refused by the FK → 409).
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

/** master_wilayah row. kodepos_wilayah must be a wilayah of the kodepos reference (or empty). */
function validateWilayah(input, knownKodeposWilayah) {
  const i = input || {};
  const name = text(i.name, 100);
  if (name.length < 3 || !kotaKey(name)) throw invalid("Wilayah name must be at least 3 characters.", "WILAYAH_NAME_INVALID");
  const code = text(i.kodepos_wilayah, 100).toUpperCase();
  let kodepos = null;
  if (code) {
    kodepos = (knownKodeposWilayah || []).find((w) => kotaKey(w) === kotaKey(code)) || null;
    if (!kodepos) throw invalid("Unknown wilayah — it must exist in the kodepos reference.", "WILAYAH_UNKNOWN");
  }
  return { name, name_key: kotaKey(name), kodepos_wilayah: kodepos, nama_pengirim_base: orNull(text(i.nama_pengirim_base)) };
}

const CUST_ID_RE = /^\d{1,15}$/;
const wilayahIdOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw invalid("Choose a wilayah.", "WILAYAH_ID_REQUIRED");
  return n;
};
const digits = (v) => String(v === null || v === undefined ? "" : v).trim();

/** master_cust_id row: numeric Cust IDs (≤ 15 digits), N and Y different. */
function validateCustIdRow(input) {
  const i = input || {};
  const wilayah_id = wilayahIdOf(i.wilayah_id);
  const nonCod = digits(i.cust_id_non_cod);
  const cod = digits(i.cust_id_cod);
  if (!CUST_ID_RE.test(nonCod) || !CUST_ID_RE.test(cod) || Number(nonCod) === 0 || Number(cod) === 0) {
    throw invalid("Cust ID must be a number (digits only, max 15).", "CUST_ID_INVALID");
  }
  if (nonCod === cod) throw invalid("The COD and Non-COD cust IDs must be different.", "CUST_ID_SAME");
  return { wilayah_id, cust_id_non_cod: nonCod, cust_id_cod: cod };
}

/** master_wilayah_kota row. Aliases: comma-separated search names ("sukareja"). */
function validateWilayahKota(input) {
  const i = input || {};
  const wilayah_id = wilayahIdOf(i.wilayah_id);
  const kota = text(i.kota, 100);
  if (kota.length < 2 || !kotaKey(kota)) throw invalid("Kota must be at least 2 characters.", "KOTA_INVALID");
  const seen = new Set();
  const aliases = String(i.aliases || "")
    .split(/[,;]/)
    .map((a) => text(a, 60))
    .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
    .join(", ");
  if (aliases.length > 255) throw invalid("Aliases are too long (max 255 characters).", "ALIASES_TOO_LONG");
  // KOTA PENGIRIM for this kota (migration 015); empty = wilayah rule.
  const kota_pengirim = orNull(text(i.kota_pengirim, 100));
  return { wilayah_id, kota, kota_key: kotaKey(kota), aliases: orNull(aliases), kota_pengirim };
}

async function assertWilayahExists(id) {
  const [row] = await query("SELECT id FROM master_wilayah WHERE id = ?", [id]);
  if (!row) throw invalid("The selected wilayah does not exist.", "WILAYAH_ID_UNKNOWN");
}

const noImport = async () => {
  throw invalid("Excel import is not available for this data.", "IMPORT_UNSUPPORTED");
};
const idOrNull = (v) => (v === undefined || v === null ? null : Number(v));
const strOrNull = (v) => (v === undefined || v === null ? null : String(v));

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

ENTITIES.wilayah = {
  entityType: "master_wilayah",
  label: "wilayah",
  table: "master_wilayah",
  importable: false,
  select: `SELECT x.id, x.name, x.kodepos_wilayah, x.nama_pengirim_base, c.cust_id_non_cod, c.cust_id_cod,
                  (SELECT COUNT(*) FROM master_wilayah_kota k WHERE k.wilayah_id = x.id) AS kota_count,
                  x.updated_at, u.username AS updated_by
             FROM master_wilayah x
             LEFT JOIN master_cust_id c ON c.wilayah_id = x.id
             LEFT JOIN users u ON u.id = x.updated_by`,
  search: ["x.name", "x.kodepos_wilayah", "x.nama_pengirim_base"],
  filters: {},
  order: "x.name",
  snapshot: (r) => pick(r, ["name", "kodepos_wilayah", "nama_pengirim_base"]),
  recordKey: (r) => r.name,
  async prepare(input) {
    return validateWilayah(input, await knownWilayah());
  },
  importFile: noImport,
};

ENTITIES["cust-id"] = {
  entityType: "master_cust_id",
  label: "Cust ID per wilayah",
  table: "master_cust_id",
  importable: false,
  select: `SELECT x.id, x.wilayah_id, w.name AS wilayah_name, x.cust_id_non_cod, x.cust_id_cod,
                  x.updated_at, u.username AS updated_by
             FROM master_cust_id x
             JOIN master_wilayah w ON w.id = x.wilayah_id
             LEFT JOIN users u ON u.id = x.updated_by`,
  countFrom: "master_cust_id x JOIN master_wilayah w ON w.id = x.wilayah_id",
  search: ["w.name", "x.cust_id_non_cod", "x.cust_id_cod"],
  filters: { wilayahId: (v) => ({ sql: "x.wilayah_id = ?", params: [Number(v) || 0] }) },
  order: "w.name",
  snapshot: (r) => ({
    wilayah_id: idOrNull(r.wilayah_id),
    wilayah: r.wilayah_name || null,
    cust_id_non_cod: strOrNull(r.cust_id_non_cod),
    cust_id_cod: strOrNull(r.cust_id_cod),
  }),
  recordKey: (r) => r.wilayah_name,
  async prepare(input) {
    const data = validateCustIdRow(input);
    await assertWilayahExists(data.wilayah_id);
    return data;
  },
  importFile: noImport,
};

ENTITIES["wilayah-kota"] = {
  entityType: "master_wilayah_kota",
  label: "kota per wilayah",
  table: "master_wilayah_kota",
  importable: false,
  select: `SELECT x.id, x.wilayah_id, w.name AS wilayah_name, x.kota, x.aliases, x.kota_pengirim,
                  x.updated_at, u.username AS updated_by
             FROM master_wilayah_kota x
             JOIN master_wilayah w ON w.id = x.wilayah_id
             LEFT JOIN users u ON u.id = x.updated_by`,
  countFrom: "master_wilayah_kota x JOIN master_wilayah w ON w.id = x.wilayah_id",
  search: ["x.kota", "x.aliases", "w.name", "x.kota_pengirim"],
  filters: { wilayahId: (v) => ({ sql: "x.wilayah_id = ?", params: [Number(v) || 0] }) },
  order: "w.name, x.kota",
  snapshot: (r) => ({
    wilayah_id: idOrNull(r.wilayah_id),
    wilayah: r.wilayah_name || null,
    kota: r.kota === undefined ? null : r.kota,
    aliases: r.aliases === undefined ? null : r.aliases,
    kota_pengirim: r.kota_pengirim === undefined ? null : r.kota_pengirim,
  }),
  recordKey: (r) => `${r.wilayah_name} / ${r.kota}`,
  async prepare(input) {
    const data = validateWilayahKota(input);
    await assertWilayahExists(data.wilayah_id);
    return data;
  },
  importFile: noImport,
};

/** Master wilayah choices for the Cust ID / kota forms and filters. */
async function masterWilayahOptions() {
  return (await query("SELECT id, name FROM master_wilayah ORDER BY name")).map((r) => ({ id: Number(r.id), name: r.name }));
}

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
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM ${e.countFrom || `${e.table} x`}${whereSql}`, params);
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
/** FK: a child row (cust ID / kota) still points at the wilayah. */
function referenced(err) {
  return err && (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451);
}
/** FK: the wilayah_id does not exist (deleted concurrently). */
function missingParent(err) {
  return err && (err.code === "ER_NO_REFERENCED_ROW_2" || err.errno === 1452);
}
/** CHECK constraint (Cust ID N = Y). */
function checkFailed(err) {
  return err && (err.code === "ER_CONSTRAINT_FAILED" || err.errno === 4025);
}
function mapWriteError(err) {
  if (duplicate(err)) return new MasterDataError("A record with the same key already exists.", 409, "DUPLICATE");
  if (missingParent(err)) return invalid("The selected wilayah does not exist.", "WILAYAH_ID_UNKNOWN");
  if (checkFailed(err)) return invalid("The COD and Non-COD cust IDs must be different.", "CUST_ID_SAME");
  return err;
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
    throw mapWriteError(err);
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
    throw mapWriteError(err);
  }
  const row = await getRow(e, id);
  return { id: Number(id), before: e.snapshot(current), after: e.snapshot(row), recordKey: e.recordKey(row), row };
}

/** @returns {{ id, before, after: null, recordKey }} */
async function remove(name, id) {
  const e = entityOf(name);
  const current = await getRow(e, id);
  if (!current) throw new MasterDataError("Record not found.", 404, "NOT_FOUND");
  try {
    await query(`DELETE FROM ${e.table} WHERE id = ?`, [Number(id)]);
  } catch (err) {
    if (referenced(err)) {
      throw new MasterDataError("This wilayah still has cust IDs or kota. Delete those first.", 409, "WILAYAH_IN_USE");
    }
    throw err;
  }
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
  validateWilayah,
  validateCustIdRow,
  validateWilayahKota,
  masterWilayahOptions,
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
