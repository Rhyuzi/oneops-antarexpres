#!/usr/bin/env node
"use strict";

/**
 * Import the gerai / HUB master (DATAHUB.xlsx: DEST CODE, CITY, HUB,
 * ANALYTIC CODE, HUB TYPE) into `loader_hub_kota` — or print the seed SQL.
 *
 *   npm run loader:hubs -- "tmp/DATAHUB.xlsx"                # upsert into DB (.env)
 *   npm run loader:hubs -- "tmp/DATAHUB.xlsx" --sql out.sql  # INSERT IGNORE seed
 *   npm run loader:hubs -- "tmp/DATAHUB.xlsx" --dry-run      # parse only
 *
 * KOTA PENERIMA labels / NAMA PENGIRIM edited in the app are never
 * overwritten by an import. Requires migration 012_loader_hub_kota.sql.
 */

const fs = require("fs");
const path = require("path");
const { parseDatahub, seedSql } = require("../loader/hubs");

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const sqlIdx = args.indexOf("--sql");
  const sqlOut = sqlIdx >= 0 ? args[sqlIdx + 1] : null;
  if (!file || (sqlIdx >= 0 && !sqlOut)) {
    console.error('Usage: node server/scripts/import-datahub.js "<DATAHUB.xlsx>" [--sql <out.sql>] [--dry-run]');
    process.exit(2);
  }

  const parsed = parseDatahub(fs.readFileSync(file), path.basename(file));
  console.log(`Parsed ${parsed.hubs.length} hubs from ${path.basename(file)} (sheet "${parsed.sheetName}").`);

  if (sqlOut) {
    fs.mkdirSync(path.dirname(sqlOut), { recursive: true });
    fs.writeFileSync(sqlOut, `-- Generated from ${path.basename(file)} by server/scripts/import-datahub.js\n` + seedSql(parsed.hubs));
    console.log(`Seed SQL written: ${sqlOut}`);
    return;
  }
  if (args.includes("--dry-run")) return;

  const { importHubs } = require("../loader/hubs");
  const { pool } = require("../db");
  try {
    const r = await importHubs(parsed.hubs, null);
    console.log(`loader_hub_kota: ${r.inserted} inserted, ${r.updated} updated, ${r.rows} in file.`);
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error("Import failed:", err.dbMessage || err.message);
  process.exit(1);
});
