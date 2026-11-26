"use strict";

/**
 * Excel I/O for the loader.
 *  - Reading uses SheetJS (`xlsx`, already a dependency): tolerant of .xlsx
 *    and legacy .xls, finds the sheet/header row that contains the needed
 *    columns (files are not required to use a fixed sheet name).
 *  - Writing uses ExcelJS (Rule 16): SheetJS community edition cannot style
 *    cells. The output is the Loader JNE layout (server/loader/jne.js):
 *    Titillium Web 9, bold centered header, thin borders on every cell,
 *    Resi as a number formatted "000000000000", phone as a number "0".
 *    Every value is a literal (numbers as numbers) — no formulas.
 *    NO RESI SICEPAT / ORDER ID padded, TGL DROP as a dd/mm/yyyy date; header
 *    fills, spacer column, frozen panes and AutoFilter come from the sheet
 *    spec (JNE_SHEET_STYLE).
 */

const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { LoaderInputError, normalizeResi } = require("./transform");
const { findDuplicateResi, summarizeDuplicates } = require("./duplicates");

/**
 * "Resi double" rows: soft red fill + dark red text (Excel's "Bad" cell
 * style), red borders, bold resi. Clearly visible, still readable/printable.
 */
const DUPLICATE_STYLE = {
  fill: "FFFFC7CE",
  font: "FF9C0006",
  border: "FFE06666",
};

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
    if (!ws["!ref"]) continue;
    // blankrows: true keeps raw[k] ↔ Excel row (first row of the range + k),
    // so warnings can name the real row number.
    const firstRow = XLSX.utils.decode_range(ws["!ref"]).s.r + 1;
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: true });
    const shown = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: true });
    const headerIdx = raw.slice(0, HEADER_SCAN_ROWS + 10).findIndex((r) => {
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
    const rowNumbers = rows.map((_, i) => firstRow + headerIdx + 1 + i);
    return { sheetName, headers, rows, rowNumbers };
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
  // Same detection as the template (hidden spaces etc.), with Excel row numbers.
  const duplicateResi = summarizeDuplicates(findDuplicateResi(table));
  return { map, sheetName: table.sheetName, rows: table.rows.length, duplicates, duplicateResi };
}

// Header groups shared by the loader layout and the JNE layout.
const PADDED_IDS = new Set(["resi", "resi sicepat", "no resi sicepat", "order id / reference number"]); // keep leading zeros
const DIGIT_IDS = new Set([
  ...PADDED_IDS, "no hp penerima", "no handphone penerima", "no handphone pengirim",
  "kodepos", "kode pos penerima", "cust id", "customer id",
]);
const DECIMALS = new Set(["berat", "berat asli", "berat/kg", "nilai barang", "nilai cod", "harga barang", "harga cod"]);

/** Column-specific number formats (Rule 16). */
function formatFor(header, value) {
  const h = norm(header);
  if (value instanceof Date) return "dd/mm/yyyy";
  if (PADDED_IDS.has(h)) return `${"0".repeat(Math.max(1, String(value).length))}`;
  if (DIGIT_IDS.has(h)) return "0";
  if (DECIMALS.has(h)) return Number.isInteger(value) ? "0" : "0.##";
  return Number.isInteger(value) ? "0" : "General";
}

/**
 * Typed cell value: identifiers that are pure digits become numbers (with a
 * format that keeps their digits, e.g. leading zeros of Resi); text stays
 * text. Values longer than 15 digits stay text (Excel precision limit).
 */
function cellValue(header, value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || value instanceof Date) return value;
  const h = norm(header);
  const s = String(value);
  if (DIGIT_IDS.has(h) && /^\d{1,15}$/.test(s)) return Number(s);
  return s;
}

const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const SPACER_WIDTH = 3;

/**
 * Adds one styled sheet (Rule 16) to an ExcelJS workbook.
 * @param {object} sheet
 * @param {string}   sheet.name
 * @param {string[]} sheet.headers
 * @param {unknown[][]} sheet.rows
 * @param {string}   [sheet.headerFill]     ARGB fill of every header cell
 * @param {Object<string,string>} [sheet.headerFills]  per-header ARGB override
 * @param {string[]} [sheet.spacerColumns]  narrow separator columns (no fill, invisible header text)
 * @param {string}   [sheet.freezeAfter]    freeze row 1 + every column up to this header
 * @param {boolean}  [sheet.autoFilter]     AutoFilter on the header row (A1 … last column)
 */
function addStyledSheet(wb, { name, headers, rows, headerFill = null, headerFills = {}, spacerColumns = [], freezeAfter = null, autoFilter = false, highlightRows = null, emphasizeColumns = [], rowNotes = null }) {
  // rowNotes: Map(0-based row index → text) — the issue reason, attached as a
  // cell note to the first emphasized column (the resi) of that row.
  // highlightRows: 0-based data row indexes painted with DUPLICATE_STYLE;
  // emphasizeColumns: headers whose cell is also bold on those rows (the resi).
  const highlight = highlightRows instanceof Set ? highlightRows : new Set(highlightRows || []);
  const emphasize = new Set(emphasizeColumns);
  const redSide = { style: "thin", color: { argb: DUPLICATE_STYLE.border } };
  const RED_BORDER = { top: redSide, left: redSide, bottom: redSide, right: redSide };
  const ws = wb.addWorksheet(name);
  const spacers = new Set(spacerColumns);

  ws.addRow(headers);
  const headerRow = ws.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const header = headers[col - 1];
    cell.border = BORDER;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    if (spacers.has(header)) {
      // Separator column: header kept (34-column layout) but not shown.
      cell.font = { ...FONT, bold: true, color: { argb: "FFFFFFFF" } };
      return;
    }
    cell.font = { ...FONT, bold: true, color: { argb: "FF000000" } };
    const fill = headerFills[header] || headerFill;
    if (fill) cell.fill = solid(fill);
  });

  rows.forEach((values, i) => {
    const row = ws.getRow(i + 2);
    headers.forEach((header, col) => {
      const raw = values[col];
      const cell = row.getCell(col + 1);
      cell.value = cellValue(header, raw);
      cell.font = FONT;
      cell.border = BORDER;
      if (rowNotes && rowNotes.has(i) && header === emphasizeColumns[0]) {
        cell.note = { texts: [{ text: rowNotes.get(i) }] };
      }
      if (highlight.has(i) && !spacers.has(header)) {
        cell.fill = solid(DUPLICATE_STYLE.fill);
        cell.font = { ...FONT, color: { argb: DUPLICATE_STYLE.font }, bold: emphasize.has(header) };
        cell.border = RED_BORDER;
      }
      if (typeof cell.value === "number" || cell.value instanceof Date) {
        // Padded ids keep the digits as read ("004689…" → format 000000000000).
        cell.numFmt = formatFor(header, PADDED_IDS.has(norm(header)) ? String(raw) : cell.value);
      }
    });
  });

  headers.forEach((header, i) => {
    if (spacers.has(header)) {
      ws.getColumn(i + 1).width = SPACER_WIDTH;
      return;
    }
    const longest = Math.max(
      String(header).length,
      ...rows.slice(0, 500).map((r) => (r[i] instanceof Date ? 10 : String(r[i] === null || r[i] === undefined ? "" : r[i]).length))
    );
    ws.getColumn(i + 1).width = Math.min(45, Math.max(12, Math.ceil(longest * 1.1) + 2));
  });

  // Frozen panes: header row always; plus columns A … freezeAfter, so the
  // identity columns stay visible while scrolling right.
  const xSplit = freezeAfter ? headers.indexOf(freezeAfter) + 1 : 0;
  ws.views = [{
    state: "frozen",
    xSplit,
    ySplit: 1,
    topLeftCell: `${xSplit ? columnLetter(xSplit + 1) : "A"}2`,
    activeCell: `${xSplit ? columnLetter(xSplit + 1) : "A"}2`,
  }];
  if (autoFilter && headers.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  }
  return ws;
}

/** 1 → "A", 34 → "AH". */
function columnLetter(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * Styled workbook with one or more sheets (first = the main one); returns a Buffer.
 * @param {Array<{name: string, headers: string[], rows: unknown[][], headerFill?: string}>} sheets
 */
async function writeWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OneOps — 3PL Loader";
  wb.created = new Date();
  for (const sheet of sheets) addStyledSheet(wb, sheet);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  DUPLICATE_STYLE, readTable, readRechecked, writeWorkbook, cellValue, formatFor, columnLetter };
