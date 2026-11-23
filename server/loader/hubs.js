"use strict";

/**
 * Gerai / HUB master (DATAHUB.xlsx → table loader_hub_kota) and the
 * KOTA PENERIMA label of the Data Warrior JNE layout.
 *
 * A 3PL template row names its last-mile hub in "Kode Gerai Terakhir"
 * (= DATAHUB "ANALYTIC CODE", e.g. A1203010) and "Nama Gerai Terakhir"
 * (= DATAHUB "HUB", e.g. "Sukabumi Sagaranten LM"). The hub's
 * `kota_penerima` label (e.g. "Kab. Sukabumi Sgr") is managed in the DB /
 * settings page — never hard-coded in the transform. Without a label (hub
 * unknown, label not set, or a template without gerai columns) the row
 * falls back to its Kota_Tujuan and is reported, so the mapping can be
 * completed.
 */

const { query } = require("../db");
const { readTable } = require("./excel");
const { LoaderInputError } = require("./transform");

const DATAHUB_COLUMNS = ["HUB", "ANALYTIC CODE"];

function keyOf(value) {
  return String(value === null || value === undefined ? "" : value).toLowerCase().replace(/[^a-z0-9]/g, "");
}
function text(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim();
}

/** "Sukabumi" → "SICEPAT SUKABUMI"; "Kab. Ciamis" → "SICEPAT CIAMIS". */
function defaultNamaPengirim(cityOrKota) {
  const city = text(cityOrKota).replace(/^(kab\.?|kabupaten|kota)\s+/i, "");
  return city ? `SICEPAT ${city.toUpperCase()}` : "SICEPAT";
}

/**
 * DATAHUB workbook (any sheet with HUB + ANALYTIC CODE; DEST CODE, CITY,
 * HUB TYPE optional) → hub rows. Duplicate hubs: the first one wins.
 */
function parseDatahub(buffer, label) {
  const table = readTable(buffer, label, DATAHUB_COLUMNS);
  const idx = (name) => table.headers.findIndex((h) => keyOf(h) === keyOf(name));
  const col = { dest: idx("DEST CODE"), city: idx("CITY"), hub: idx("HUB"), code: idx("ANALYTIC CODE"), type: idx("HUB TYPE") };
  const get = (row, i) => (i < 0 ? "" : text(row[i]));
  const seen = new Set();
  const hubs = [];
  for (const row of table.rows) {
    const hub = get(row, col.hub);
    if (!hub || seen.has(keyOf(hub))) continue;
    seen.add(keyOf(hub));
    hubs.push({
      destCode: get(row, col.dest),
      city: get(row, col.city),
      hub,
      analyticCode: get(row, col.code).toUpperCase(),
      hubType: get(row, col.type),
    });
  }
  if (!hubs.length) throw new LoaderInputError(`No hub rows found in "${label}".`, "DATAHUB_EMPTY");
  return { sheetName: table.sheetName, hubs };
}

/**
 * hub rows (DB shape: hub, analytic_code, city, kota_penerima, nama_pengirim)
 * → lookup(meta, kotaTujuan) for one output row.
 * Result: { label, namaPengirim, source: "mapping"|"fallback", reason, hub }
 *   reason (fallback only): "no_gerai" | "unknown_hub" | "no_label"
 */
function buildHubLookup(hubRows) {
  const byCode = new Map();
  const byName = new Map();
  for (const h of hubRows || []) {
    if (h.analytic_code) byCode.set(String(h.analytic_code).toUpperCase().trim(), h);
    byName.set(keyOf(h.hub), h);
  }
  return function lookupKotaPenerima(meta, kotaTujuan) {
    const code = meta && meta.geraiCode ? meta.geraiCode.toUpperCase() : "";
    const name = meta && meta.geraiName ? meta.geraiName : "";
    const hub = (code && byCode.get(code)) || (name && byName.get(keyOf(name))) || null;
    const kota = text(kotaTujuan);
    const namaPengirim = (hub && text(hub.nama_pengirim)) || defaultNamaPengirim(hub ? hub.city : kota);
    if (hub && text(hub.kota_penerima)) {
      return { label: text(hub.kota_penerima), namaPengirim, source: "mapping", reason: null, hub: hub.hub };
    }
    const reason = !code && !name ? "no_gerai" : hub ? "no_label" : "unknown_hub";
    return { label: kota, namaPengirim, source: "fallback", reason, hub: hub ? hub.hub : name || code || null };
  };
}

// --- DB -------------------------------------------------------------------------------

function isMissingTable(err) {
  return err && (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146);
}

/** All hubs (lookup + settings). [] when migration 012 is not applied. */
async function loadHubs() {
  try {
    return await query(
      `SELECT h.id, h.dest_code, h.city, h.hub, h.analytic_code, h.hub_type, h.kota_penerima,
              h.nama_pengirim, h.source, h.updated_at, u.username AS updated_by
         FROM loader_hub_kota h LEFT JOIN users u ON u.id = h.updated_by
        ORDER BY h.city, h.hub`
    );
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * Upserts DATAHUB rows by hub name. Master columns (dest code, city, analytic
 * code, hub type) are refreshed; KOTA PENERIMA / NAMA PENGIRIM set in
 * settings are never overwritten by an import.
 */
async function importHubs(hubs, userId) {
  let inserted = 0;
  let updated = 0;
  // mysql2 sets CLIENT_FOUND_ROWS: an unchanged duplicate also reports
  // affectedRows = 1, so "new" is decided from the keys present beforehand.
  const existing = new Set((await query("SELECT hub_key FROM loader_hub_kota")).map((r) => r.hub_key));
  for (const h of hubs) {
    const res = await query(
      `INSERT INTO loader_hub_kota (hub_key, hub, dest_code, city, analytic_code, hub_type, nama_pengirim, source, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?)
       ON DUPLICATE KEY UPDATE hub = VALUES(hub), dest_code = VALUES(dest_code), city = VALUES(city),
         analytic_code = VALUES(analytic_code), hub_type = VALUES(hub_type)`,
      [keyOf(h.hub), h.hub, h.destCode || null, h.city || null, h.analyticCode || null, h.hubType || null,
        defaultNamaPengirim(h.city), userId || null]
    );
    if (!existing.has(keyOf(h.hub))) {
      inserted++;
      existing.add(keyOf(h.hub));
    } else if (res.changedRows > 0 || res.affectedRows === 2) updated++;
  }
  return { rows: hubs.length, inserted, updated };
}

/** SQL seed (INSERT IGNORE) for a DATAHUB file — used by the import script. */
function seedSql(hubs, labels = {}) {
  const esc = (v) => (v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`);
  const values = hubs.map((h) => {
    const label = labels[keyOf(h.hub)] || null;
    return `  (${esc(keyOf(h.hub))}, ${esc(h.hub)}, ${esc(h.destCode)}, ${esc(h.city)}, ${esc(h.analyticCode)}, ${esc(h.hubType)}, ${esc(label)}, ${esc(defaultNamaPengirim(h.city))}, 'seed')`;
  });
  return (
    "INSERT IGNORE INTO loader_hub_kota\n  (hub_key, hub, dest_code, city, analytic_code, hub_type, kota_penerima, nama_pengirim, source)\nVALUES\n" +
    values.join(",\n") +
    ";\n"
  );
}

module.exports = {
  DATAHUB_COLUMNS,
  keyOf,
  defaultNamaPengirim,
  parseDatahub,
  buildHubLookup,
  loadHubs,
  importHubs,
  seedSql,
  isMissingTable,
};
