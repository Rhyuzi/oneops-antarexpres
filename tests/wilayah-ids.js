"use strict";

/**
 * Live-test helper: Master Data ids of a wilayah + kota (migration 014 seed).
 * The 3PL Loader request carries only { wilayahId, kotaId }; the server reads
 * the Cust IDs from the DB (Subang: N 82220303 / Y 82220300).
 */
async function wilayahIds(query, wilayah = "subang", kota = "kalijati") {
  const [r] = await query(
    `SELECT w.id AS wilayahId, k.id AS kotaId
       FROM master_wilayah w JOIN master_wilayah_kota k ON k.wilayah_id = w.id
      WHERE w.name_key = ? AND k.kota_key = ?`,
    [wilayah, kota]
  );
  if (!r) throw new Error(`migration 014 seed missing: ${wilayah} / ${kota} — run database/migrations/014_master_wilayah.sql`);
  return { wilayahId: Number(r.wilayahId), kotaId: Number(r.kotaId) };
}

module.exports = { wilayahIds };
