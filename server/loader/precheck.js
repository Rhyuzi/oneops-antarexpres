"use strict";

/**
 * Pre-check of a 3PL template BEFORE any SiCepat call (loader API mode) —
 * catches problems that would waste API quota or produce a broken file:
 *
 *  errors   (blocking): missing required columns, no data rows
 *  warnings (need explicit confirmation): duplicate Resi, empty Resi,
 *            kecamatan missing / still ambiguous after the Kota_Tujuan →
 *            wilayah mapping, unknown COD values
 *
 * Pure (no I/O): the kodepos lookup is passed in, exactly as for the run.
 */

const { REQUIRED_COLUMNS, normalizeResi, codCategory } = require("./transform");

const LIST_CAP = 200;

function norm(h) {
  return String(h === null || h === undefined ? "" : h).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * @param {{headers: string[], rows: unknown[][]}} table
 * @param {{lookupKodepos: (kecamatan: string, kota: string) => {kodepos: string|null, status: string, options?: string[]}}} opts
 */
function precheckTemplate(table, { lookupKodepos }) {
  const idx = (name) => table.headers.findIndex((h) => norm(h) === norm(name));
  const rows = table.rows.filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined));
  const errors = [];
  const missingColumns = REQUIRED_COLUMNS.filter((c) => idx(c) < 0);
  if (missingColumns.length) errors.push({ code: "MISSING_COLUMNS", columns: missingColumns });
  if (!rows.length) errors.push({ code: "NO_ROWS" });

  const result = {
    ok: false,
    errors,
    warnings: [],
    counts: { rows: rows.length, uniqueResi: 0, cod: 0, nonCod: 0 },
  };
  if (errors.length) return result;

  const ri = idx("Resi");
  const ki = idx("Kecamatan Tujuan");
  const kota = idx("Kota_Tujuan");
  const ci = idx("COD");

  // Resi: duplicates / empty.
  const seen = new Map();
  let emptyResi = 0;
  for (const r of rows) {
    const key = normalizeResi(r[ri]);
    if (!key) {
      emptyResi++;
      continue;
    }
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  result.counts.uniqueResi = seen.size;
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([resi, count]) => ({ resi, count }));

  // Kecamatan → kodepos (same lookup + mapping as the real run).
  const missing = new Map();
  const ambiguous = new Map();
  for (const r of rows) {
    const kec = String(r[ki] === null || r[ki] === undefined ? "" : r[ki]).trim();
    const res = lookupKodepos(kec, kota >= 0 ? String(r[kota] || "") : "");
    if (res.kodepos) continue;
    if (res.status === "ambiguous") {
      const prev = ambiguous.get(kec) || { kecamatan: kec, count: 0, options: res.options || [] };
      prev.count++;
      ambiguous.set(kec, prev);
    } else {
      const k = kec || "(empty)";
      missing.set(k, (missing.get(k) || 0) + 1);
    }
  }

  // COD values.
  const unknownCod = new Map();
  for (const r of rows) {
    const cat = codCategory(r[ci]);
    if (cat === "cod") result.counts.cod++;
    else if (cat === "noncod") result.counts.nonCod++;
    else {
      const v = String(r[ci] === null || r[ci] === undefined ? "" : r[ci]).trim() || "(empty)";
      unknownCod.set(v, (unknownCod.get(v) || 0) + 1);
    }
  }

  const add = (code, items) => items.length && result.warnings.push({ code, count: items.length, items: items.slice(0, LIST_CAP) });
  add("DUPLICATE_RESI", duplicates);
  if (emptyResi) result.warnings.push({ code: "EMPTY_RESI", count: emptyResi, items: [] });
  add("KECAMATAN_MISSING", [...missing].map(([kecamatan, count]) => ({ kecamatan, count })));
  add("KECAMATAN_AMBIGUOUS", [...ambiguous.values()]);
  add("UNKNOWN_COD", [...unknownCod].map(([value, count]) => ({ value, count })));

  result.ok = true;
  return result;
}

/** Unique, non-empty Resi values in first-seen order (what the API queue looks up). */
function uniqueResiList(table) {
  const ri = table.headers.findIndex((h) => norm(h) === "resi");
  const out = [];
  const seen = new Set();
  for (const r of table.rows) {
    const raw = r[ri];
    const key = normalizeResi(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Same AWB format the browser rechecker sends (src/lib/api.ts): digits
    // only, leading zeros kept ("004689202216").
    out.push({ key, awb: String(raw).replace(/\D/g, "") });
  }
  return out;
}

module.exports = { precheckTemplate, uniqueResiList };
