"use strict";

/**
 * Data Warrior — bulk create folders from an Excel list.
 *
 * readFolderNames(buffer): the first sheet with a "Folder" / "Nama Folder" /
 * "Folder Name" / "Nama" header (any column, first 10 rows); otherwise the
 * first column holding a value (a plain list without header). Every name
 * keeps its Excel row number for the notification.
 *
 * planFolders(names, existing): which names to create and which to skip:
 *   duplicate_in_file  same name earlier in the file (firstRow = that row)
 *   exists             a folder with that name already exists in the target
 *   invalid            empty after trim, > 191 characters or with line breaks
 * Names are compared trimmed, inner spaces collapsed and case-insensitive
 * (the folder table's collation treats "Garut" and "GARUT" as equal too).
 * Pure — unit-tested in tests/test-folder-bulk.js.
 */

const XLSX = require("xlsx");

const MAX_FOLDERS = 500;
const HEADER_RE = /^(nama\s*)?folder(\s*name)?$|^nama$|^name$/i;

class BulkFolderError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const tidy = (v) => String(v === null || v === undefined ? "" : v).replace(/[ \t\u00a0]+/g, " ").trim();
const keyOf = (name) => tidy(name).toLowerCase();

function readFolderNames(buffer, fileName = "folders.xlsx") {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (_) {
    throw new BulkFolderError(`The file "${fileName}" could not be read as Excel.`, "UNREADABLE_FILE");
  }
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const firstRow = XLSX.utils.decode_range(ws["!ref"]).s.r + 1;
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: true, raw: false });
    let col = -1;
    let start = 0;
    for (let r = 0; r < Math.min(10, grid.length) && col < 0; r++) {
      const c = (grid[r] || []).findIndex((v) => HEADER_RE.test(tidy(v)));
      if (c >= 0) {
        col = c;
        start = r + 1;
      }
    }
    if (col < 0) {
      const width = Math.max(0, ...grid.map((row) => row.length));
      for (let c = 0; c < width && col < 0; c++) if (grid.some((row) => tidy(row[c]))) col = c;
    }
    if (col < 0) continue;
    const names = [];
    for (let i = start; i < grid.length; i++) {
      const raw = (grid[i] || [])[col];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      names.push({ row: firstRow + i, name: String(raw) });
    }
    if (names.length) return { sheetName, names };
  }
  throw new BulkFolderError("No folder names were found in the file.", "NO_FOLDER_NAMES");
}

/** Same rule as single folder creation: 1–191 characters, no line breaks. */
function validName(name) {
  const n = tidy(name);
  return n.length >= 1 && n.length <= 191 && !/[\r\n\0]/.test(String(name));
}

/**
 * @param {Array<{row: number, name: string}>} names
 * @param {string[]} existing  names of the folders already in the target
 */
function planFolders(names, existing = []) {
  if (names.length > MAX_FOLDERS) {
    throw new BulkFolderError(`Too many folder names (max ${MAX_FOLDERS} per file).`, "TOO_MANY_FOLDERS");
  }
  const taken = new Set(existing.map(keyOf));
  const firstRowOf = new Map();
  const create = [];
  const skipped = [];
  for (const { row, name } of names) {
    const clean = tidy(name);
    if (!validName(name)) {
      skipped.push({ row, name: clean.slice(0, 191), reason: "invalid" });
      continue;
    }
    const key = keyOf(clean);
    if (firstRowOf.has(key)) {
      skipped.push({ row, name: clean, reason: "duplicate_in_file", firstRow: firstRowOf.get(key) });
      continue;
    }
    firstRowOf.set(key, row);
    if (taken.has(key)) {
      skipped.push({ row, name: clean, reason: "exists" });
      continue;
    }
    create.push({ row, name: clean });
  }
  return { create, skipped };
}

module.exports = { MAX_FOLDERS, BulkFolderError, readFolderNames, planFolders, keyOf, validName };
