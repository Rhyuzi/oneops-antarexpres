#!/usr/bin/env node
"use strict";

/**
 * Retries the R2 deletions that failed when Data Warrior folders / files were
 * deleted (table storage_r2_cleanup, migration 016).
 *
 *   npm run storage:r2-cleanup            # retry every pending object
 *   npm run storage:r2-cleanup -- --list  # only show what is pending
 *
 * A row is marked resolved once R2 confirms the deletion (deleting an object
 * that is already gone also counts as done); otherwise its attempts grow.
 */

const { query, pool } = require("../db");
const { retryPendingCleanup } = require("../storageDelete");

async function main() {
  const [{ n }] = await query("SELECT COUNT(*) AS n FROM storage_r2_cleanup WHERE resolved_at IS NULL");
  console.log(`Pending R2 objects: ${n}`);
  if (process.argv.includes("--list") || !Number(n)) return;
  const r = await retryPendingCleanup();
  console.log(`Retried ${r.pending}: ${r.deleted} deleted, ${r.failed} still failing.`);
  if (r.failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.code === "ER_NO_SUCH_TABLE" ? "Run database/migrations/016_storage_r2_cleanup.sql first." : err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
