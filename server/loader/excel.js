"use strict";

/**
 * Excel I/O for the loader.
 *  - Reading uses SheetJS (`xlsx`, already a dependency): tolerant of .xlsx
 *    and legacy .xls, finds the sheet/header row that contains the needed
 *    columns (files are not required to use a fixed sheet name).
 *  - Writing uses ExcelJS (Rule 16): SheetJS community edition cannot style
 *    cells. Styling mirrors the "TAMPILAN FINAL" sheet of the master file:
 *    Titillium Web 9, bold centered header, thin borders on every cell,
 *    Resi as a number formatted "000000000000", phone as a number "0".
 *    Every value is a literal (numbers as numbers) — no formulas.
 */

const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { LoaderInputError, normalizeResi } = require("./transform");

const FONT = { name: "Titillium Web", size: 9 };
const THIN = { style: "thin" };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEADER_SCAN_ROWS = 15;

function norm(h) {
  return String(h === null || h === undefined ? "" : h).trim().replace(/\s+/g, " ").toLowerCase();
}

function readWorkbook(buffer, label) {
  try {
    return XLSX.read(buffer, { type: "buffer", cellDates: false });
  } catch (err) {
    throw new LoaderInputError(`The file "${label}" could not be read as Excel.`, "UNREADABLE_FILE");
  }
}

/**
 * Finds the first sheet whose header row (within the first rows) contains all
 * `required` headers. Returns { sheetName, headers, rows } with raw values;
 * cells that display leading zeros (e.g. Resi "004689…" stored as a number
 * with a zero-padded format) keep their displayed text.
 */
function readTable(buffer, label, required) {
  const wb = readWorkbook(buffer, label);
  const want = required.map(norm);
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: false });
    const shown = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
    const headerIdx = raw.slice(0, HEADER_SCAN_ROWS).findIndex((r) => {
      const have = new Set(r.map(norm));
      return want.every((h) => have.has(h));
    });
    if (headerIdx < 0) continue;
    const headers = raw[headerIdx].map((h) => String(h === null || h === undefined ? "" : h).trim());
    const rows = raw.slice(headerIdx + 1).map((r, i) =>
      headers.map((_, col) => {
        const v = r[col];
        const text = shown[headerIdx + 1 + i] ? shown[headerIdx + 1 + i][col] : undefined;
        // Keep zero-padded identifiers as displayed ("004689202216").
        if (typeof v === "number" && typeof text === "string" && /^0\d+$/.test(text)) return text;
        return v === undefined ? "" : v;
      })
    );
    return { sheetName, headers, rows };
  }
  throw new LoaderInputError(
    `No sheet in "${label}" has the required columns: ${required.join(", ")}.`,
    "HEADERS_NOT_FOUND",
    required
  );
}

/**
 * Rechecked workbook → Map(normalized resi → phone text). Duplicate resi:
 * the first non-empty phone wins; the number of duplicates is reported.
 */
function readRechecked(buffer, label) {
  const table = readTable(buffer, label, ["Resi", "No HP Penerima"]);
  const ri = table.headers.findIndex((h) => norm(h) === "resi");
  const pi = table.headers.findIndex((h) => norm(h) === "no hp penerima");
  const map = new Map();
  let duplicates = 0;
  for (const row of table.rows) {
    const key = normalizeResi(row[ri]);
    if (!key) continue;
    const phone = row[pi] === null || row[pi] === undefined ? "" : String(row[pi]).trim();
    if (map.has(key)) {
      duplicates++;
      if (!map.get(key) && phone) map.set(key, phone);
      continue;
    }
    map.set(key, phone);
  }
  return { map, sheetName: table.sheetName, rows: table.rows.length, duplicates };
}

/** Column-specific number formats (Rule 16). */
function formatFor(header, value) {
  const h = norm(header);
  if (h === "resi") return `${"0".repeat(Math.max(1, String(value).length))}`;
  if (h === "no hp penerima" || h === "kodepos" || h === "cust id") return "0";
  if (h === "berat" || h === "berat asli") return Number.isInteger(value) ? "0" : "0.##";
  if (h === "nilai barang" || h === "nilai cod") return Number.isInteger(value) ? "0" : "0.##";
  return Number.isInteger(value) ? "0" : "General";
}

/**
 * Typed cell value: identifiers that are pure digits become numbers (with a
 * format that keeps their digits, e.g. leading zeros of Resi); text stays
 * text. Values longer than 15 digits stay text (Excel precision limit).
 */
function cellValue(header, value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const h = norm(header);
  const s = String(value);
  if ((h === "resi" || h === "no hp penerima" || h === "kodepos" || h === "cust id") && /^\d{1,15}$/.test(s)) return Number(s);
  return s;
}

/** Builds the styled output workbook; returns a Buffer. */
async function writeLoaderWorkbook(headers, rows, { sheetName = "Sheet1" } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OneOps — 3PL Loader";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);

  ws.addRow(headers);
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { ...FONT, bold: true };
    cell.alignment = { horizontal: "center", vertical: "top" };
    cell.border = BORDER;
  });

  rows.forEach((values, i) => {
    const row = ws.getRow(i + 2);
    headers.forEach((header, col) => {
      const raw = values[col];
      const cell = row.getCell(col + 1);
      cell.value = cellValue(header, raw);
      cell.font = FONT;
      cell.border = BORDER;
      if (typeof cell.value === "number") {
        const original = norm(header) === "resi" ? String(raw) : cell.value;
        cell.numFmt = formatFor(header, norm(header) === "resi" ? original : cell.value);
      }
    });
  });

  headers.forEach((header, i) => {
    const longest = Math.max(
      String(header).length,
      ...rows.slice(0, 500).map((r) => String(r[i] === null || r[i] === undefined ? "" : r[i]).length)
    );
    ws.getColumn(i + 1).width = Math.min(60, Math.max(20.73, Math.ceil(longest * 0.95)));
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { readTable, readRechecked, writeLoaderWorkbook, cellValue, formatFor };
