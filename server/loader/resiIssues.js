"use strict";

/**
 * Resi issues — the reasons a resi of the 3PL template is marked red
 * (pre-check panel, 409 confirmation, result panel, and the KETERANGAN ISSUE
 * column at the edge of the Loader JNE file).
 *
 * Issues per row (structured; texts are built per language):
 *   { type: "duplicate", rows: [26, 49] }   every Excel row with the same resi
 *   { type: "invalid",   chars: ["!", "?"] } characters that break /^\d+$/
 * A row may have both; a valid, unique row has none (note "").
 *
 * Rule: the resi is trim()med (outer spaces / tabs / line breaks / NBSP), then
 * must match /^\d+$/. Anything else is an invalid character — symbols (!, ?, /),
 * letters, a space INSIDE the resi, invisible characters (zero-width …).
 * Spaces and invisible characters are named in the note ("spasi", "U+200B")
 * so the operator can find them. Duplicates are compared on the digits
 * (duplicates.js), so "4691353011" and "4691353011!" are also a double.
 *
 * Texts: TEXT mirrors the UI dictionary keys loader.resiIssue.* in
 * src/i18n/locales/{en,id}.ts (tests/test-resi-issues.js keeps them equal),
 * so the file speaks the language selected in the app.
 */

const { findDuplicateResi, resiDisplay } = require("./duplicates");
const { isEmptyCell } = require("./transform");

const TEXT = {
  en: {
    duplicate: "Duplicate resi (rows {rows})",
    invalid: "Invalid characters: {chars} (digits only)",
    separator: " | ",
    space: "space",
    column: "ISSUE NOTE",
    phoneInvalid: "Invalid recipient phone number",
    phoneEmpty: "Recipient phone number missing",
  },
  id: {
    duplicate: "Resi double (baris {rows})",
    invalid: "Karakter tidak valid: {chars} (hanya boleh angka)",
    separator: " | ",
    space: "spasi",
    column: "KETERANGAN ISSUE",
    phoneInvalid: "No HP penerima tidak valid",
    phoneEmpty: "No HP penerima kosong",
  },
};
const localeOf = (l) => (l === "en" ? "en" : "id"); // operators work in Indonesian by default

/** The resi as processed: trim() only (outer whitespace incl. NBSP / line breaks). */
function trimResi(value) {
  if (typeof value === "number") return resiDisplay(value);
  return String(value === null || value === undefined ? "" : value).trim();
}

/** Characters that break /^\d+$/ after trim(), unique, in order of appearance. */
function invalidChars(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? [] : [...new Set(String(value).replace(/[0-9]/g, ""))];
  }
  const s = trimResi(value);
  if (/^\d+$/.test(s)) return [];
  const out = [];
  for (const ch of s) if (!/[0-9]/.test(ch) && !out.includes(ch)) out.push(ch);
  return out;
}

/** Resi as shown in panels and written to the file: trimmed, otherwise as typed. */
const resiText = trimResi;

/** Invisible or control character (named by its code point in notes). */
function isInvisible(ch) {
  const cp = ch.codePointAt(0);
  return (
    cp < 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xad ||
    (cp >= 0x2000 && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) ||
    cp === 0x2060 || cp === 0x3000 || cp === 0xfeff
  );
}

/** " " → "spasi" / "space"; invisible → "U+200B"; others as they are. */
function charLabel(ch, locale = "id") {
  if (ch === " ") return TEXT[localeOf(locale)].space;
  if (isInvisible(ch)) return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  return ch;
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

/** Phone issue of a row ("empty" | "invalid") → note in the given language. */
function phoneIssueText(issue, locale = "id") {
  const T = TEXT[localeOf(locale)];
  return issue === "empty" ? T.phoneEmpty : issue === "invalid" ? T.phoneInvalid : "";
}

/** Issue list → one line in the given language ("" when there is none). */
function issueText(issues, locale = "id") {
  const T = TEXT[localeOf(locale)];
  return (issues || [])
    .map((x) =>
      x.type === "duplicate"
        ? T.duplicate.replace("{rows}", x.rows.join(", "))
        : x.type === "invalid"
          ? T.invalid.replace("{chars}", x.chars.map((c) => charLabel(c, locale)).join(", "))
          : ""
    )
    .filter(Boolean)
    .join(T.separator);
}

module.exports = { TEXT, localeOf, invalidChars, resiText, trimResi, isInvisible, charLabel, analyzeResi, issueText, phoneIssueText };
