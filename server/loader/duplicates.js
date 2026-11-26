"use strict";

/**
 * Duplicate Resi ("resi double") detection — run BEFORE the 3PL transform /
 * export on the template (and on the rechecked file).
 *
 * Normalization = transform.normalizeResi: digits only, leading zeros ignored.
 * So hidden characters never hide a duplicate: spaces, tabs, line breaks,
 * non-breaking spaces (U+00A0), zero-width characters (U+200B–U+200D, U+FEFF),
 * a leading apostrophe ('4691353011) or "4691353011.0"-style text all count
 * as the same resi. A number cell and its text version match too.
 *
 * Every occurrence is reported with its Excel row number so the operator can
 * find it; the export marks the rows red (excel.js DUPLICATE_STYLE).
 */

const { normalizeResi, isEmptyCell } = require("./transform");

const LIST_CAP = 200;

function norm(h) {
  return String(h === null || h === undefined ? "" : h).trim().replace(/\s+/g, " ").toLowerCase();
}

/** "4691353011.0" (float text from Excel) → "4691353011" before normalization. */
function resiKey(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return normalizeResi(Number.isInteger(value) ? String(value) : String(Math.round(value)));
  const s = String(value).replace(/[\s ​-‍﻿]+/g, "").replace(/^'/, "").replace(/\.0+$/, "");
  return normalizeResi(s);
}

/** Resi as the operator sees it: digits only, leading zeros kept. */
function resiDisplay(value) {
  if (typeof value === "number") return String(Math.round(value));
  return String(value === null || value === undefined ? "" : value).replace(/\.0+$/, "").replace(/\D/g, "");
}

/**
 * @param {{headers: string[], rows: unknown[][], rowNumbers?: number[]}} table
 * @param {{column?: string}} [opts]
 * @returns {{groups: number, rows: number, items: Array<{resi: string, key: string, count: number, rows: number[]}>, keys: Set<string>, rowSet: Set<number>}}
 *   groups = distinct resi appearing more than once; rows = rows involved;
 *   rowSet = Excel row numbers of every duplicate occurrence.
 */
function findDuplicateResi(table, { column = "Resi" } = {}) {
  const ri = table.headers.findIndex((h) => norm(h) === norm(column));
  const empty = { groups: 0, rows: 0, items: [], keys: new Set(), rowSet: new Set() };
  if (ri < 0) return empty;
  const byKey = new Map();
  table.rows.forEach((row, i) => {
    if (!row || row.every(isEmptyCell)) return;
    const key = resiKey(row[ri]);
    if (!key) return;
    const n = table.rowNumbers ? table.rowNumbers[i] : i + 2;
    const g = byKey.get(key) || { resi: resiDisplay(row[ri]), key, count: 0, rows: [] };
    g.count++;
    g.rows.push(n);
    byKey.set(key, g);
  });
  const dups = [...byKey.values()].filter((g) => g.count > 1).sort((a, b) => a.rows[0] - b.rows[0]);
  const out = {
    groups: dups.length,
    rows: dups.reduce((s, g) => s + g.count, 0),
    items: dups.slice(0, LIST_CAP), // reports / API (capped)
    allItems: dups, // every group (per-row issue notes)
    keys: new Set(dups.map((g) => g.key)),
    rowSet: new Set(dups.flatMap((g) => g.rows)),
  };
  return out;
}

/** JSON-safe summary (reports, API responses, job history). */
function summarizeDuplicates(d) {
  return { groups: d.groups, rows: d.rows, items: d.items.map(({ resi, count, rows }) => ({ resi, count, rows: rows.slice(0, 50) })) };
}

module.exports = { findDuplicateResi, summarizeDuplicates, resiKey, resiDisplay };
