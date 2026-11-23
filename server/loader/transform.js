"use strict";

/**
 * Automation Loader — the 17 transformation rules, as PURE functions
 * (no I/O), so every rule is unit-testable (tests/test-loader.js).
 *
 * Data model: a sheet is { headers: string[], rows: unknown[][] }. Rules are
 * applied strictly in the documented order; each one mutates a working copy
 * and records what it did in `report`.
 *
 * OUTPUT: these rows are INTERMEDIATE only. The exported .xlsx is built from
 * them by server/loader/jne.js — exactly the 34 Data Warrior "Loader JNE"
 * columns (TANGGAL … CUSTOMER ID). The intermediate header names below
 * ("Berat Asli", "KODEPOS", "CUST ID" …) never reach the file.
 *
 * Interpretations confirmed against the sample files (see docs):
 *  - Rule 2: "Berat Asli" takes the place of "Asal_kecamatan" (which is
 *    dropped) and sits right of "Berat" in the intermediate rows, where Rule 4
 *    reads it. "Status Terakhir" becomes the cust id ("CUST ID", Rule 10) —
 *    exported as CUSTOMER ID.
 *  - Rule 4: decimal part ≥ 0.3 rounds UP, below 0.3 rounds DOWN, min 1
 *    (0.75→1, 9.1→9, 2.3→3). Only when Berat ≥ 2 and Berat Asli ≤ Berat;
 *    the result never exceeds the original Berat (Berat only goes down).
 *    Switchable: opts.convertWeight === false keeps Berat exactly as in the
 *    template. Default ON. The result is exported as BERAT/KG.
 *  - Rule 3 sorts by the FINAL Berat (after Rule 4 when the switch is on,
 *    the template value when off), so order and Rules 12/14 always use the
 *    same Berat that is written to the file.
 *  - Rule 6: KODEPOS is inserted directly LEFT of "Kecamatan Tujuan"
 *    (intermediate; exported as KODE POS PENERIMA).
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

/**
 * Columns checked for empty cells (warning, never blocking). "Nilai COD" is
 * only checked on COD rows; "No HP Penerima" / "Nilai Barang" are not — they
 * are replaced (rechecked/API) or defaulted (Rule 9) and reported there.
 */
const EMPTY_CHECK_COLUMNS = [
  "Resi", "Berat", "Berat Asli", "Penerima", "Kota_Tujuan", "Kecamatan Tujuan",
  "Alamat Penerima", "Nama Barang", "COD", "Biaya", "Nilai COD",
];

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
  // Hard rule: Berat may only go DOWN, never up.
  // 1) Berat Asli heavier than Berat → keep Berat as is (e.g. 5 / 6.3 → 5).
  if (clean(a) > clean(b)) return { berat: b, reason: "guard_asli_greater" };
  // 2) Rounding up must not exceed the original Berat either (e.g. a
  //    fractional Berat 2.5 with Berat Asli 2.4 would round to 3) → cap at b.
  const next = Math.min(roundWeight(a), b);
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

/**
 * COD column → "cod" | "noncod" | null (unknown — never guessed, reported).
 * Accepted: COD / Y / YA / YES / TRUE / 1  and  NON-COD / NON COD / NONCOD /
 * N / NO / TIDAK / FALSE / 0 (case, spaces, "-" and "_" ignored). The output
 * COD column is always "Y" / "N" for known values (Rules 11/13).
 */
const COD_VALUES = new Set(["COD", "Y", "YA", "YES", "TRUE", "1"]);
const NON_COD_VALUES = new Set(["NONCOD", "N", "NO", "TIDAK", "FALSE", "0"]);
function codCategory(value) {
  if (value === true) return "cod";
  if (value === false) return "noncod";
  const v = String(value === null || value === undefined ? "" : value).toUpperCase().replace(/[\s_-]/g, "");
  if (COD_VALUES.has(v)) return "cod";
  if (NON_COD_VALUES.has(v)) return "noncod";
  return null;
}

/** Address on one line: CR/LF → one space, runs of whitespace collapsed, trimmed. */
function cleanAddress(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();
}

/** Empty = null, undefined, or a string that is blank after trimming. */
function isEmptyCell(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
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
 * Empty-data warnings for the template's data rows (never blocking):
 *  - rows:        [{ row (Excel row), resi, columns: [...] }]  (EMPTY_CHECK_COLUMNS)
 *  - byColumn:    [{ column, count }]
 *  - emptyColumns: output columns empty on EVERY row
 *  - blankRows:   fully blank Excel rows between data rows (skipped)
 * Shared by the pre-check and the transform so both report the same thing.
 */
function detectEmpty({ headers, rows, rowNumbers, blankRows = [] }) {
  const idx = (name) => headers.findIndex((h) => normHeader(h) === normHeader(name));
  const codIdx = idx("COD");
  const resiIdx = idx("Resi");
  const checked = EMPTY_CHECK_COLUMNS.map((name) => ({ name, i: idx(name) })).filter((x) => x.i >= 0);
  const out = { cells: 0, rowsWithEmpty: 0, byColumn: [], rows: [], emptyColumns: [], blankRows: blankRows.slice(0, LIST_CAP) };
  const byColumn = new Map();
  rows.forEach((row, n) => {
    const isCod = codIdx >= 0 && codCategory(row[codIdx]) === "cod";
    const cols = [];
    for (const { name, i } of checked) {
      if (name === "Nilai COD" && !isCod) continue;
      if (isEmptyCell(row[i])) {
        cols.push(headers[i]);
        byColumn.set(headers[i], (byColumn.get(headers[i]) || 0) + 1);
      }
    }
    if (!cols.length) return;
    out.cells += cols.length;
    out.rowsWithEmpty++;
    pushCapped(out.rows, {
      row: rowNumbers ? rowNumbers[n] : n + 2,
      resi: resiIdx < 0 || isEmptyCell(row[resiIdx]) ? "" : String(row[resiIdx]).trim(),
      columns: cols,
    });
  });
  out.byColumn = [...byColumn].map(([column, count]) => ({ column, count })).sort((a, b) => b.count - a.count);
  // Columns empty on EVERY row — only those that reach the output (Rule 1 drops the rest).
  const removed = new Set(REMOVED_COLUMNS);
  out.emptyColumns = rows.length
    ? headers.filter((h, i) => h && !removed.has(normHeader(h)) && rows.every((r) => isEmptyCell(r[i])))
    : [];
  return out;
}

/**
 * Runs Rules 1–15 (Rule 16 = Excel formatting, Rule 17 = two cust ids are
 * inputs here). Throws LoaderInputError for unusable input.
 *
 * @param {{headers: string[], rows: unknown[][], rowNumbers?: number[]}} template
 *   3PL template sheet; rowNumbers = Excel row of each data row (warnings)
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
  // Blank rows are skipped (and reported with their Excel row number).
  const numbered = template.rows.map((r, i) => ({ r, n: template.rowNumbers ? template.rowNumbers[i] : i + 2 }));
  const blank = numbered.filter((x) => x.r.every(isEmptyCell));
  const kept = numbered.filter((x) => !x.r.every(isEmptyCell));
  const lastDataRow = kept.length ? kept[kept.length - 1].n : 0;
  const sheet = makeSheet(template.headers, kept.map((x) => x.r));
  // Per-row facts that outlive Rule 1 / Rule 15 (row arrays keep identity
  // through splice/sort): Excel row, gerai (→ KOTA PENERIMA), Koli.
  const rowMeta = new WeakMap();
  {
    const gi = colIndex(sheet, "Kode Gerai Terakhir");
    const gn = colIndex(sheet, "Nama Gerai Terakhir");
    const ko = colIndex(sheet, "Koli");
    const text = (row, i) => (i < 0 || isEmptyCell(row[i]) ? "" : String(row[i]).trim());
    sheet.rows.forEach((row, i) => {
      const koli = ko < 0 ? NaN : toNumber(row[ko]);
      rowMeta.set(row, {
        rowNumber: kept[i].n,
        geraiCode: text(row, gi),
        geraiName: text(row, gn),
        koli: Number.isFinite(koli) && koli >= 1 ? Math.round(koli) : 1,
      });
    });
  }

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
    addressCleaned: 0,
    empty: null,
  };

  // Empty rows / columns / cells (warnings with Excel row + column name).
  report.empty = detectEmpty({
    headers: sheet.headers,
    rows: sheet.rows,
    rowNumbers: kept.map((x) => x.n),
    blankRows: blank.filter((x) => x.n < lastDataRow).map((x) => x.n),
  });

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

  // Alamat Penerima on one line (CR/LF → space, extra spaces removed).
  {
    const ai = c("Alamat Penerima");
    if (ai >= 0) {
      for (const row of sheet.rows) {
        const before = row[ai];
        const after = cleanAddress(before);
        if (typeof before === "string" && after !== before) report.addressCleaned++;
        row[ai] = after;
      }
    }
  }

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

  // Rule 5 — Berat Asli stays in the intermediate rows (not exported: the
  // Loader JNE layout has BERAT/KG only).

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

  return { headers: sheet.headers, rows: sheet.rows, meta: sheet.rows.map((r) => rowMeta.get(r)), report };
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
  cleanAddress,
  isEmptyCell,
  detectEmpty,
  EMPTY_CHECK_COLUMNS,
  nonCodNilaiBarang,
  codNilaiBarang,
  transformTemplate,
};
