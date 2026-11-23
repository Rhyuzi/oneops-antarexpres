"use strict";

/**
 * Automation Loader — the 17 transformation rules, as PURE functions
 * (no I/O), so every rule is unit-testable (tests/test-loader.js).
 *
 * Data model: a sheet is { headers: string[], rows: unknown[][] }. Rules are
 * applied strictly in the documented order; each one mutates a working copy
 * and records what it did in `report`.
 *
 * Interpretations confirmed against the sample files (see docs):
 *  - Rule 2: "Berat Asli" takes the place of "Asal_kecamatan" (which is
 *    dropped) and sits directly RIGHT of "Berat". It is KEPT in the output
 *    for manual checking (Rule 5 no longer deletes it), so the output is the
 *    "TAMPILAN FINAL" layout of KEBUTUHAN LOADER.xlsx plus "Berat Asli"
 *    after "Berat", with "Status Terakhir" renamed "CUST ID" (Rule 10).
 *  - Rule 4: decimal part ≥ 0.3 rounds UP, below 0.3 rounds DOWN, min 1
 *    (0.75→1, 9.1→9, 2.3→3). Only when Berat ≥ 2 and Berat Asli ≤ Berat.
 *    Switchable: opts.convertWeight === false keeps Berat exactly as in the
 *    template (Berat Asli is still kept/shown). Default ON.
 *  - Rule 3 sorts by the FINAL Berat (after Rule 4 when the switch is on,
 *    the template value when off), so order and Rules 12/14 always use the
 *    same Berat that is written to the file.
 *  - Rule 6: KODEPOS is inserted directly LEFT of "Kecamatan Tujuan"
 *    (as in TAMPILAN FINAL).
 *  - Rules 12/14 write the computed value into "Nilai Barang"; the Berat
 *    used is the normalized one (Rule 4 ran before).
 */

// --- Rule 1: columns removed (matched case-insensitively, trimmed) ------------
const REMOVED_COLUMNS = [
  "partner", "perwakilan tujuan", "kode gerai manifest", "gerai manifest",
  "kode gerai terakhir", "nama gerai terakhir", "pengirim", "no hp pengirim",
  "kota pengirim", "keterangan", "nomor pesanan e-commerce", "layanan",
  "asuransi biaya", "tanggal status terakhir", "tanggal manifest", "status sla",
  "tujuan", "status_public", "tgl_status_public", "kota_asal", "zona",
  "claim_value", "threshold", "sla max", "max x days (edd)",
];

/**
 * INPUT columns the rules need; checked before anything runs.
 * Note: the template's "Status Terakhir" is required here — "CUST ID" is only
 * the OUTPUT name of that column (renamed by Rule 10). Requiring "CUST ID"
 * would reject every real 3PL template.
 */
const REQUIRED_COLUMNS = [
  "Resi", "Berat", "Berat Asli", "No HP Penerima", "Kecamatan Tujuan",
  "Nilai Barang", "COD", "Biaya", "Nilai COD", "Status Terakhir",
];

const DEFAULT_NILAI_BARANG = 500000; // Rule 9
const CUST_ID_HEADER = "CUST ID"; // Rule 10: output name of the "Status Terakhir" column
const COD_FEE_PER_KG = 2800; // Rule 14
const WEIGHT_RULE_MIN_BERAT = 2; // Rule 4 applies only when Berat ≥ 2
const ROUND_UP_FRACTION = 0.3; // Rule 4 threshold
const LIST_CAP = 500; // max items per report list

function normHeader(h) {
  return String(h === undefined || h === null ? "" : h).trim().replace(/\s+/g, " ").toLowerCase();
}

class LoaderInputError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = 400;
  }
}

/** Number from a cell (number, "12.5", "12,5", "Rp 12.000"); NaN when not numeric. */
function toNumber(value) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return NaN;
  let s = String(value).trim();
  if (!s) return NaN;
  s = s.replace(/[^\d.,-]/g, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 12.000,5
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", "."); // 12,5
  else s = s.replace(/,/g, ""); // 12,000.5
  const n = Number(s);
  return s === "" || Number.isNaN(n) ? NaN : n;
}

/** Tames binary float noise (0.7000000000000001 → 0.7). */
function clean(n) {
  return Math.round(n * 1000) / 1000;
}

// --- Rule 4 ---------------------------------------------------------------------

/** Rounds "Berat Asli" to whole kilos: fraction ≥ 0.3 up, else down, min 1. */
function roundWeight(beratAsli) {
  const v = clean(beratAsli);
  const whole = Math.floor(v);
  const fraction = clean(v - whole);
  return Math.max(1, fraction >= ROUND_UP_FRACTION ? whole + 1 : whole);
}

/**
 * Rule 4 for one row. Returns the (possibly) new Berat and why.
 * reason: normalized | unchanged | below_threshold | guard_asli_greater | invalid
 */
function applyWeightRule(berat, beratAsli) {
  const b = toNumber(berat);
  const a = toNumber(beratAsli);
  if (!Number.isFinite(b)) return { berat, reason: "invalid" };
  if (b < WEIGHT_RULE_MIN_BERAT) return { berat: b, reason: "below_threshold" };
  if (!Number.isFinite(a)) return { berat: b, reason: "invalid" };
  // Guard: never change Berat when Berat Asli is heavier than Berat.
  if (clean(a) > clean(b)) return { berat: b, reason: "guard_asli_greater" };
  const next = roundWeight(a);
  return next === b ? { berat: b, reason: "unchanged" } : { berat: next, reason: "normalized" };
}

// --- Rule 8 ---------------------------------------------------------------------
// One shared rule (server/recheck/phone.js) for the loader and the recheck
// queues — see that file for the exact normalization.
const { normalizePhone } = require("../recheck/phone");

/** Resi as matched between files: digits only, leading zeros ignored. */
function normalizeResi(value) {
  return String(value === null || value === undefined ? "" : value).trim().replace(/\D/g, "").replace(/^0+/, "");
}

// --- Rules 10–14 ------------------------------------------------------------------

/** COD column → "cod" | "noncod" | null (unknown). */
function codCategory(value) {
  const v = String(value === null || value === undefined ? "" : value).toUpperCase().replace(/[\s_-]/g, "");
  if (v === "COD" || v === "Y" || v === "YA" || v === "YES") return "cod";
  if (v === "NONCOD" || v === "N" || v === "NO" || v === "TIDAK") return "noncod";
  return null;
}

/** Rule 12: (Biaya × Berat) + Nilai Barang. */
function nonCodNilaiBarang(biaya, berat, nilaiBarang) {
  return clean(toNumber(biaya) * toNumber(berat) + toNumber(nilaiBarang));
}

/** Rule 14: Nilai COD − (Berat × 2800). */
function codNilaiBarang(nilaiCod, berat) {
  return clean(toNumber(nilaiCod) - toNumber(berat) * COD_FEE_PER_KG);
}

// --- sheet helpers ------------------------------------------------------------------

function makeSheet(headers, rows) {
  return { headers: headers.map((h) => String(h === null || h === undefined ? "" : h).trim()), rows: rows.map((r) => [...r]) };
}
function colIndex(sheet, name) {
  const target = normHeader(name);
  return sheet.headers.findIndex((h) => normHeader(h) === target);
}
function removeColumn(sheet, index) {
  sheet.headers.splice(index, 1);
  for (const row of sheet.rows) row.splice(index, 1);
}
function insertColumn(sheet, index, header, values) {
  sheet.headers.splice(index, 0, header);
  sheet.rows.forEach((row, i) => {
    while (row.length < index) row.push("");
    row.splice(index, 0, values[i]);
  });
}
function pushCapped(list, item) {
  if (list.length < LIST_CAP) list.push(item);
}

/**
 * Runs Rules 1–15 (Rule 16 = Excel formatting, Rule 17 = two cust ids are
 * inputs here). Throws LoaderInputError for unusable input.
 *
 * @param {{headers: string[], rows: unknown[][]}} template  3PL template sheet
 * @param {object} opts
 * @param {Map<string,string>} opts.rechecked   normalizeResi(resi) → phone
 * @param {(kecamatan: string, kotaTujuan: string) => {kodepos: string|null, status: string, options?: string[]}} opts.lookupKodepos
 * @param {string} opts.custIdCod
 * @param {string} opts.custIdNonCod
 * @param {boolean} [opts.convertWeight=true]  Rule 4 on/off (Berat from Berat Asli)
 */
function transformTemplate(template, opts) {
  const { rechecked, lookupKodepos, custIdCod, custIdNonCod } = opts;
  const convertWeight = opts.convertWeight !== false;
  const sheet = makeSheet(template.headers, template.rows.filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined)));

  const missing = REQUIRED_COLUMNS.filter((c) => colIndex(sheet, c) < 0);
  if (missing.length) {
    throw new LoaderInputError(`The 3PL template is missing required columns: ${missing.join(", ")}.`, "MISSING_COLUMNS", missing);
  }
  if (!sheet.rows.length) throw new LoaderInputError("The 3PL template has no data rows.", "NO_ROWS");

  const report = {
    rows: sheet.rows.length,
    removedColumns: [],
    beratAsliPlacement: null,
    weight: { conversion: convertWeight, normalized: 0, unchanged: 0, belowThreshold: 0, guardSkipped: 0, invalid: [] },
    kodepos: { filled: 0, missing: [], ambiguous: [] },
    phone: { fromRechecked: 0, notInRechecked: [], normalized: 0, invalid: [] },
    nilaiBarangDefaulted: 0,
    cod: 0,
    nonCod: 0,
    unknownCod: [],
    negativeNilaiBarang: [],
    invalidNumbers: [],
  };

  // Rule 1 — drop unused columns.
  const removeSet = new Set(REMOVED_COLUMNS);
  for (let i = sheet.headers.length - 1; i >= 0; i--) {
    if (removeSet.has(normHeader(sheet.headers[i]))) {
      report.removedColumns.unshift(sheet.headers[i]);
      removeColumn(sheet, i);
    }
  }

  // Rule 2 — Berat Asli moves directly right of Berat (Asal_kecamatan, whose
  // place it took in the manual workflow, is dropped). Values are cleaned of
  // float noise (0.7000000000000001 → 0.7) since the column stays visible.
  {
    const asli = colIndex(sheet, "Berat Asli");
    const values = sheet.rows.map((r) => {
      const n = toNumber(r[asli]);
      return Number.isFinite(n) ? clean(n) : r[asli];
    });
    const header = sheet.headers[asli];
    removeColumn(sheet, asli);
    const asal = colIndex(sheet, "Asal_kecamatan");
    if (asal >= 0) removeColumn(sheet, asal);
    report.removedAsalKecamatan = asal >= 0;
    insertColumn(sheet, colIndex(sheet, "Berat") + 1, header, values);
    report.beratAsliPlacement = "after_berat";
  }

  const c = (name) => colIndex(sheet, name);
  const resiOf = (row) => String(row[c("Resi")] === undefined ? "" : row[c("Resi")]);

  // Rule 4 — normalize Berat from Berat Asli (Berat ≥ 2, guard Asli > Berat).
  // Switch off → Berat stays as in the template (only invalid values reported).
  {
    const bi = c("Berat");
    const ai = c("Berat Asli");
    for (const row of sheet.rows) {
      if (!convertWeight) {
        const b = toNumber(row[bi]);
        if (!Number.isFinite(b)) pushCapped(report.weight.invalid, { resi: resiOf(row), berat: row[bi], beratAsli: row[ai] });
        else {
          row[bi] = b; // same value, stored as a number (not derived from Berat Asli)
          report.weight.unchanged++;
        }
        continue;
      }
      const r = applyWeightRule(row[bi], row[ai]);
      if (r.reason === "invalid") pushCapped(report.weight.invalid, { resi: resiOf(row), berat: row[bi], beratAsli: row[ai] });
      else row[bi] = r.berat;
      if (r.reason === "normalized") report.weight.normalized++;
      else if (r.reason === "unchanged") report.weight.unchanged++;
      else if (r.reason === "below_threshold") report.weight.belowThreshold++;
      else if (r.reason === "guard_asli_greater") report.weight.guardSkipped++;
    }
  }

  // Rule 3 — sort by the final Berat, small → large (stable; non-numeric last).
  {
    const bi = c("Berat");
    const keyed = sheet.rows.map((row, i) => ({ row, i, b: toNumber(row[bi]) }));
    keyed.sort((x, y) => {
      const xf = Number.isFinite(x.b);
      const yf = Number.isFinite(y.b);
      if (xf && yf && x.b !== y.b) return x.b - y.b;
      if (xf !== yf) return xf ? -1 : 1;
      return x.i - y.i;
    });
    sheet.rows = keyed.map((k) => k.row);
  }

  // Rule 5 — Berat Asli is KEPT (right of Berat) for manual checking.

  // Rule 6 — KODEPOS next to (left of) Kecamatan Tujuan, from kebutuhan_loader.
  {
    const ki = c("Kecamatan Tujuan");
    const kota = c("Kota_Tujuan");
    const missingCount = new Map();
    const ambiguous = new Map();
    const values = sheet.rows.map((row) => {
      const kecamatan = String(row[ki] === undefined || row[ki] === null ? "" : row[ki]).trim();
      const res = lookupKodepos(kecamatan, kota >= 0 ? String(row[kota] || "") : "");
      if (res.kodepos) {
        report.kodepos.filled++;
        return res.kodepos;
      }
      if (res.status === "ambiguous") ambiguous.set(kecamatan, res.options || []);
      else missingCount.set(kecamatan || "(empty)", (missingCount.get(kecamatan || "(empty)") || 0) + 1);
      return "";
    });
    insertColumn(sheet, ki, "KODEPOS", values);
    report.kodepos.missing = [...missingCount].map(([kecamatan, count]) => ({ kecamatan, count })).slice(0, LIST_CAP);
    report.kodepos.ambiguous = [...ambiguous].map(([kecamatan, options]) => ({ kecamatan, options })).slice(0, LIST_CAP);
  }

  // Rule 7 — No HP Penerima from the rechecked file (matched by Resi).
  const pi = c("No HP Penerima");
  for (const row of sheet.rows) {
    const key = normalizeResi(row[c("Resi")]);
    if (key && rechecked.has(key)) {
      row[pi] = rechecked.get(key);
      report.phone.fromRechecked++;
    } else {
      pushCapped(report.phone.notInRechecked, resiOf(row));
    }
  }

  // Rule 8 — normalize to 628…; invalid numbers are kept (digits) and flagged.
  for (const row of sheet.rows) {
    const p = normalizePhone(row[pi]);
    if (p.changed && p.valid) report.phone.normalized++;
    if (!p.valid) pushCapped(report.phone.invalid, { resi: resiOf(row), value: String(row[pi] === undefined ? "" : row[pi]), issue: p.issue });
    row[pi] = p.value;
  }

  // Rule 9 — Nilai Barang 0/empty → 500000.
  const ni = c("Nilai Barang");
  for (const row of sheet.rows) {
    const v = toNumber(row[ni]);
    if (!Number.isFinite(v) || v === 0) {
      row[ni] = DEFAULT_NILAI_BARANG;
      report.nilaiBarangDefaulted++;
    } else row[ni] = v;
  }

  const ci = c("COD");
  const categories = sheet.rows.map((row) => {
    const cat = codCategory(row[ci]);
    if (!cat) pushCapped(report.unknownCod, { resi: resiOf(row), value: String(row[ci] === undefined ? "" : row[ci]) });
    return cat;
  });

  // Rule 10 — Status Terakhir becomes the cust id of the row's category,
  // and the column is renamed "CUST ID" in the output.
  const si = c("Status Terakhir");
  sheet.rows.forEach((row, i) => {
    // Cust ids are digit-only (validated) and written as numbers.
    if (categories[i] === "cod") row[si] = Number(custIdCod);
    else if (categories[i] === "noncod") row[si] = Number(custIdNonCod);
  });
  sheet.headers[si] = CUST_ID_HEADER;

  const bi = c("Berat");
  const biaya = c("Biaya");
  const nci = c("Nilai COD");
  const checkNumber = (row, field, value) => {
    if (!Number.isFinite(value)) pushCapped(report.invalidNumbers, { resi: resiOf(row), field });
    return Number.isFinite(value);
  };

  // Rule 11 — Non-COD → "N".
  sheet.rows.forEach((row, i) => {
    if (categories[i] === "noncod") row[ci] = "N";
  });
  // Rule 12 — Non-COD Nilai Barang = (Biaya × Berat) + Nilai Barang.
  sheet.rows.forEach((row, i) => {
    if (categories[i] !== "noncod") return;
    report.nonCod++;
    const value = nonCodNilaiBarang(row[biaya], row[bi], row[ni]);
    if (checkNumber(row, "Biaya", toNumber(row[biaya])) && checkNumber(row, "Berat", toNumber(row[bi]))) row[ni] = value;
  });
  // Rule 13 — COD → "Y".
  sheet.rows.forEach((row, i) => {
    if (categories[i] === "cod") row[ci] = "Y";
  });
  // Rule 14 — COD Nilai Barang = Nilai COD − (Berat × 2800).
  sheet.rows.forEach((row, i) => {
    if (categories[i] !== "cod") return;
    report.cod++;
    if (!checkNumber(row, "Nilai COD", toNumber(row[nci])) || !checkNumber(row, "Berat", toNumber(row[bi]))) return;
    const value = codNilaiBarang(row[nci], row[bi]);
    row[ni] = value;
    if (value < 0) pushCapped(report.negativeNilaiBarang, { resi: resiOf(row), value });
  });
  // Numeric output for Nilai COD too (Rule 16: numbers, never text/formulas).
  for (const row of sheet.rows) {
    const v = toNumber(row[nci]);
    if (Number.isFinite(v)) row[nci] = v;
  }

  // Rule 15 — drop Koli and Biaya (after every calculation).
  for (const name of ["Koli", "Biaya"]) {
    const i = c(name);
    if (i >= 0) removeColumn(sheet, i);
  }

  return { headers: sheet.headers, rows: sheet.rows, report };
}

module.exports = {
  REMOVED_COLUMNS,
  REQUIRED_COLUMNS,
  DEFAULT_NILAI_BARANG,
  CUST_ID_HEADER,
  COD_FEE_PER_KG,
  LoaderInputError,
  toNumber,
  roundWeight,
  applyWeightRule,
  normalizePhone,
  normalizeResi,
  codCategory,
  nonCodNilaiBarang,
  codNilaiBarang,
  transformTemplate,
};
