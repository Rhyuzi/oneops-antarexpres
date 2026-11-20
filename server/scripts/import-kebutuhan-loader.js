#!/usr/bin/env node
"use strict";

/**
 * Import the kodepos master workbook (KEBUTUHAN LOADER.xlsx) into the
 * `kebutuhan_loader` table — or generate an idempotent seed SQL file.
 *
 *   npm run loader:import -- "path/KEBUTUHAN LOADER.xlsx"          # upsert into DB (.env)
 *   npm run loader:import -- "path/KEBUTUHAN LOADER.xlsx" --sql database/seeds/003_kebutuhan_loader.sql
 *   npm run loader:import -- "path/KEBUTUHAN LOADER.xlsx" --dry-run  # parse only
 *
 * Every sheet with a "Kecamatan | Kode pos" header row is imported; the sheet
 * name becomes `wilayah` (TASIK, GARUT, SUBANG, SUKABUMI …). Re-running is
 * safe: existing rows are only touched (updated_at), new rows are inserted.
 * Requires migration 010_kebutuhan_loader.sql for the DB mode.
 */

const fs = require("fs");
const path = require("path");
const { parseMasterWorkbook, toSeedSql } = require("../loader/kodepos");

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const sqlIdx = args.indexOf("--sql");
  const sqlOut = sqlIdx >= 0 ? args[sqlIdx + 1] : null;
  const dryRun = args.includes("--dry-run");

  if (!file || (sqlIdx >= 0 && !sqlOut)) {
    console.error('Usage: node server/scripts/import-kebutuhan-loader.js "<KEBUTUHAN LOADER.xlsx>" [--sql <out.sql>] [--dry-run]');
    process.exit(2);
  }

  const parsed = parseMasterWorkbook(fs.readFileSync(file));
  console.log(`Parsed ${parsed.rows.length} unique rows from ${path.basename(file)}:`);
  for (const s of parsed.sheets) console.log(`  ${s.wilayah.padEnd(12)} ${s.rows} rows`);
  for (const [w, ids] of Object.entries(parsed.custIds)) {
    console.log(`  cust id ${w}: N (Non-COD) = ${ids.N || "-"}, Y (COD) = ${ids.Y || "-"}`);
  }
  if (!parsed.rows.length) {
    console.error("No rows found (each sheet needs a header row: Kecamatan | Kode Pos).");
    process.exit(1);
  }

  if (sqlOut) {
    fs.mkdirSync(path.dirname(sqlOut), { recursive: true });
    fs.writeFileSync(sqlOut, toSeedSql(parsed.rows, path.basename(file)));
    console.log(`Seed SQL written: ${sqlOut}`);
    return;
  }
  if (dryRun) return;

  const { upsertReference } = require("../loader/kodepos");
  const { pool } = require("../db");
  try {
    const r = await upsertReference(parsed.rows);
    console.log(`kebutuhan_loader: ${r.inserted} inserted, ${r.unchanged} already present, ${r.total} total.`);
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error("Import failed:", err.dbMessage || err.message);
  process.exit(1);
});
