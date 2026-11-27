"use strict";

/**
 * Kodepos reference (table `kebutuhan_loader`): parsing the master workbook,
 * DB load/upsert, and the kecamatan → kodepos lookup used by Rule 6.
 *
 * Matching: kecamatan names are compared on a normalized key (case, spaces,
 * punctuation and a "Kec./Kecamatan" prefix ignored), so "Langkap Lancar",
 * "Langkaplancar" and "KEC. LANGKAPLANCAR" are the same kecamatan.
 *
 * Ambiguity: the same kecamatan name can map to several kodepos (e.g.
 * "Tamansari" 46191/46146 in TASIK, "Pabuaran" in SUBANG and SUKABUMI). The
 * lookup then narrows by wilayah, in this order:
 *   1. the wilayah chosen in the UI (explicit override),
 *   2. the Kota_Tujuan → wilayah mapping (table loader_kota_wilayah, e.g.
 *      "Kab. Ciamis" / "Kota Banjar" → TASIK),
 *   3. a wilayah name contained in Kota_Tujuan ("Kab. Subang" → SUBANG).
 * Still ambiguous → no value is guessed; the row is reported as ambiguous.
 */

const XLSX = require("xlsx");
const { query } = require("../db");

function keyOf(value) {
  return String(value === null || value === undefined ? "" : value)
    .toLowerCase()
    .trim()
    .replace(/^(kec\.?|kecamatan)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Fallback spellings of a kecamatan cell: "Cihideung, Kota Tasikmalaya",
 * "Cihideung / Tasik", "Cihideung (Kota)", "Cihideung - Kota Tasikmalaya"
 * → "Cihideung"; "Kawalu Kota Tasikmalaya" → "Kawalu".
 */
function kecamatanVariants(value) {
  const s = String(value === null || value === undefined ? "" : value).trim();
  const out = [];
  const first = s.split(/[,/(]| - /)[0].trim();
  if (first && first !== s) out.push(first);
  const noRegion = first.replace(/\s+(kota|kab\.?|kabupaten)\b.*$/i, "").trim();
  if (noRegion && noRegion !== first) out.push(noRegion);
  return out;
}

/** Standalone 5-digit numbers in a text (an address): "… Tasikmalaya 46115" → ["46115"]. */
function kodeposFromText(text) {
  const out = [];
  const re = /(^|[^0-9])([0-9]{5})(?![0-9])/g;
  let m;
  const s = String(text === null || text === undefined ? "" : text);
  while ((m = re.exec(s))) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

function cleanName(value) {
  return String(value === null || value === undefined ? "" : value).trim().replace(/\s+/g, " ");
}

function cleanKodepos(value) {
  const digits = String(value === null || value === undefined ? "" : value).trim().replace(/\.0+$/, "").replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 16 ? digits : "";
}

/**
 * Builds the Rule 6 lookup from reference rows.
 * @param {Array<{wilayah: string|null, kecamatan: string, kodepos: string}>} refRows
 * @param {{wilayah?: string|null, kotaMap?: Array<{kota: string, wilayah: string}>}} [options]
 *        wilayah = explicit choice from the UI; kotaMap = Kota_Tujuan → wilayah mapping
 */
function buildKodeposLookup(refRows, options = {}) {
  const byKey = new Map();
  for (const r of refRows) {
    const k = keyOf(r.kecamatan);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ wilayah: r.wilayah ? String(r.wilayah) : null, kodepos: String(r.kodepos) });
  }
  const wilayahKeys = [...new Set(refRows.map((r) => keyOf(r.wilayah)).filter(Boolean))];
  const selected = keyOf(options.wilayah);
  const kotaToWilayah = new Map((options.kotaMap || []).map((m) => [keyOf(m.kota), keyOf(m.wilayah)]));

  /** Wilayah key for a Kota_Tujuan: mapping table first, then name containment. */
  function wilayahForKota(kotaTujuan) {
    const kota = keyOf(kotaTujuan);
    if (!kota) return null;
    return kotaToWilayah.get(kota) || inferWilayah(kotaTujuan);
  }

  function inferWilayah(kotaTujuan) {
    const kota = keyOf(kotaTujuan);
    if (!kota) return null;
    return wilayahKeys.find((w) => kota.includes(w)) || null;
  }

  const knownKodepos = new Set(refRows.map((r) => String(r.kodepos)));

  function lookupKodepos(kecamatan, kotaTujuan) {
    let candidates = byKey.get(keyOf(kecamatan)) || [];
    // "Cihideung, Kota Tasikmalaya" & co.: retry with the bare kecamatan name.
    for (const v of candidates.length ? [] : kecamatanVariants(kecamatan)) {
      candidates = byKey.get(keyOf(v)) || [];
      if (candidates.length) break;
    }
    if (!candidates.length) return { kodepos: null, status: "missing" };
    const distinct = (list) => [...new Set(list.map((c) => c.kodepos))];
    if (distinct(candidates).length === 1) return { kodepos: candidates[0].kodepos, status: "ok" };

    for (const scope of [selected, wilayahForKota(kotaTujuan)]) {
      if (!scope) continue;
      const scoped = distinct(candidates.filter((c) => keyOf(c.wilayah) === scope));
      if (scoped.length === 1) return { kodepos: scoped[0], status: "ok" };
    }
    return {
      kodepos: null,
      status: "ambiguous",
      options: candidates.map((c) => `${c.kodepos}${c.wilayah ? ` (${c.wilayah})` : ""}`),
      candidates: distinct(candidates),
    };
  }
  /** Is this kodepos in the reference (any wilayah)? */
  lookupKodepos.isKnown = (kodepos) => knownKodepos.has(String(kodepos));
  return lookupKodepos;
}

/**
 * Parses the master workbook (KEBUTUHAN LOADER.xlsx): every sheet with a
 * header row whose first two cells look like "Kecamatan" / "Kode pos"
 * contributes rows; the sheet name becomes `wilayah`. Sheets without such a
 * header (e.g. "TAMPILAN FINAL") are skipped. Duplicates are removed.
 * Also returns the CATEGORY → CUST ID side tables found in each sheet.
 */
function parseMasterWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const rows = [];
  const seen = new Set();
  const sheets = [];
  const custIds = {};
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true });
    const headerIdx = grid.findIndex(
      (r) => /kecamatan/i.test(String(r[0] || "")) && /(kode\s*pos|kodepos)/i.test(String(r[1] || ""))
    );
    if (headerIdx < 0) continue;
    const wilayah = cleanName(name).toUpperCase().slice(0, 100);
    let count = 0;
    for (const r of grid.slice(headerIdx + 1)) {
      const kecamatan = cleanName(r[0]).slice(0, 150);
      const kodepos = cleanKodepos(r[1]);
      if (!kecamatan || !kodepos) continue;
      const k = `${wilayah}|${kecamatan.toLowerCase()}|${kodepos}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ wilayah, kecamatan, kodepos });
      count++;
    }
    // Side table "CATEGORY | CUST ID" (N / Y) — informational.
    const catRow = grid.findIndex((r) => r.some((cell) => /^category$/i.test(String(cell).trim())));
    if (catRow >= 0) {
      const col = grid[catRow].findIndex((cell) => /^category$/i.test(String(cell).trim()));
      const ids = {};
      for (const r of grid.slice(catRow + 1, catRow + 4)) {
        const cat = String(r[col] || "").trim().toUpperCase();
        const id = String(r[col + 1] || "").trim();
        if ((cat === "N" || cat === "Y") && id) ids[cat] = id;
      }
      if (Object.keys(ids).length) custIds[wilayah] = ids;
    }
    sheets.push({ wilayah, rows: count });
  }
  return { rows, sheets, custIds };
}

/** All reference rows (small table: a few hundred rows). */
async function loadReference() {
  return query("SELECT wilayah, kecamatan, kodepos FROM kebutuhan_loader ORDER BY wilayah, kecamatan");
}

/**
 * Upserts reference rows. Idempotent: existing (wilayah, kecamatan, kodepos)
 * rows are only touched (updated_at); new rows are inserted.
 * Returns { inserted, unchanged, total }.
 */
async function upsertReference(rows) {
  if (!rows.length) return { inserted: 0, unchanged: 0, total: (await countReference()) };
  const before = await countReference();
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await query(
      `INSERT INTO kebutuhan_loader (wilayah, kecamatan, kodepos) VALUES ?
       ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
      [chunk.map((r) => [r.wilayah || null, r.kecamatan, r.kodepos])]
    );
  }
  const total = await countReference();
  const inserted = total - before;
  return { inserted, unchanged: rows.length - inserted, total };
}

async function countReference() {
  const [{ n }] = await query("SELECT COUNT(*) AS n FROM kebutuhan_loader");
  return Number(n);
}

/** INSERT … ON DUPLICATE KEY UPDATE seed SQL for the given rows. */
function toSeedSql(rows, sourceName) {
  const esc = (v) => (v === null ? "NULL" : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`);
  const lines = rows.map((r) => `  (${esc(r.wilayah)}, ${esc(r.kecamatan)}, ${esc(r.kodepos)})`);
  return [
    "-- ============================================================================",
    `-- 003_kebutuhan_loader.sql — kodepos reference generated from ${sourceName}`,
    "-- Generated by: node server/scripts/import-kebutuhan-loader.js --sql <file>",
    "-- Requires migration 010. Idempotent: re-running only refreshes updated_at.",
    "-- ============================================================================",
    "",
    "SET NAMES utf8mb4;",
    "",
    "INSERT INTO `kebutuhan_loader` (`wilayah`, `kecamatan`, `kodepos`) VALUES",
    lines.join(",\n"),
    "ON DUPLICATE KEY UPDATE `updated_at` = CURRENT_TIMESTAMP;",
    "",
  ].join("\n");
}

module.exports = {
  keyOf,
  kecamatanVariants,
  kodeposFromText,
  buildKodeposLookup,
  parseMasterWorkbook,
  loadReference,
  upsertReference,
  countReference,
  toSeedSql,
};
