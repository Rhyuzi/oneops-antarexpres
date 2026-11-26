"use strict";

/**
 * Resi issues — the reasons a resi of the 3PL template is marked red
 * (pre-check panel, 409 confirmation, result panel, cell note in the JNE file).
 *
 * Issues per row (structured; texts are built per language):
 *   { type: "duplicate", rows: [26, 49] }   every Excel row with the same resi
 *   { type: "invalid",   chars: ["!", "?"] } visible non-digit characters
 * A row may have both; a valid, unique row has none (note "").
 *
 * Hidden characters are NOT issues: spaces, NBSP, zero-width characters, a
 * leading apostrophe and a trailing ".0" are cleaned (they come from copy /
 * paste and Excel), exactly like the duplicate detection (duplicates.js).
 *
 * Texts: TEXT mirrors the UI dictionary keys loader.resiIssue.* in
 * src/i18n/locales/{en,id}.ts (tests/test-resi-issues.js keeps them equal),
 * so the note in the file speaks the language selected in the app.
 */

const { findDuplicateResi, resiDisplay } = require("./duplicates");
const { isEmptyCell } = require("./transform");

const TEXT = {
  en: {
    duplicate: "Duplicate resi (rows {rows})",
    invalid: "Invalid characters: {chars} (digits only)",
    separator: "; ",
  },
  id: {
    duplicate: "Resi double (baris {rows})",
    invalid: "Karakter tidak valid: {chars} (hanya boleh angka)",
    separator: "; ",
  },
};
const localeOf = (l) => (l === "en" ? "en" : "id"); // operators work in Indonesian by default

/** Characters removed silently before checking (never an issue). */
const CLEANABLE = /[\s ​-‍﻿]/g;

/** Visible non-digit characters of a resi, unique, in order of appearance. */
function invalidChars(value) {
  if (value === null || value === undefined || typeof value === "number") return [];
  const s = String(value).replace(CLEANABLE, "").replace(/^'/, "").replace(/\.0+$/, "");
  const out = [];
  for (const ch of s) if (!/[0-9]/.test(ch) && !out.includes(ch)) out.push(ch);
  return out;
}

/** Resi as shown in panels: the cell text without hidden characters. */
function resiText(value) {
  if (typeof value === "number") return resiDisplay(value);
  return String(value === null || value === undefined ? "" : value).replace(CLEANABLE, "").replace(/^'/, "").replace(/\.0+$/, "");
}

/**
 * Every data row with its issues.
 * @param {{headers: string[], rows: unknown[][], rowNumbers?: number[]}} table
 * @returns {{rows: Array<{row: number, resi: string, issues: object[]}>, summary: {total: number, valid: number, withIssues: number, duplicateGroups: number, duplicateRows: number, invalidRows: number}, byRow: Map<number, object[]>}}
 */
function analyzeResi(table, { column = "Resi" } = {}) {
  const ri = table.headers.findIndex((h) => String(h || "").trim().toLowerCase() === column.toLowerCase());
  const dups = findDuplicateResi(table, { column });
  const groupOfRow = new Map();
  for (const g of dups.allItems || dups.items) for (const n of g.rows) groupOfRow.set(n, g);
  const rows = [];
  const byRow = new Map();
  let invalidRows = 0;
  table.rows.forEach((r, i) => {
    if (!r || r.every(isEmptyCell)) return;
    const raw = ri < 0 ? "" : r[ri];
    if (isEmptyCell(raw)) return;
    const n = table.rowNumbers ? table.rowNumbers[i] : i + 2;
    const issues = [];
    const g = groupOfRow.get(n);
    if (g) issues.push({ type: "duplicate", rows: g.rows.slice() });
    const chars = invalidChars(raw);
    if (chars.length) {
      issues.push({ type: "invalid", chars });
      invalidRows++;
    }
    rows.push({ row: n, resi: resiText(raw), issues });
    if (issues.length) byRow.set(n, issues);
  });
  return {
    rows,
    byRow,
    summary: {
      total: rows.length,
      valid: rows.length - byRow.size,
      withIssues: byRow.size,
      duplicateGroups: dups.groups,
      duplicateRows: dups.rows,
      invalidRows,
    },
  };
}

/** Issue list → one line in the given language ("" when there is none). */
function issueText(issues, locale = "id") {
  const T = TEXT[localeOf(locale)];
  return (issues || [])
    .map((x) =>
      x.type === "duplicate"
        ? T.duplicate.replace("{rows}", x.rows.join(", "))
        : x.type === "invalid"
          ? T.invalid.replace("{chars}", x.chars.join(", "))
          : ""
    )
    .filter(Boolean)
    .join(T.separator);
}

module.exports = { TEXT, localeOf, invalidChars, resiText, analyzeResi, issueText };
