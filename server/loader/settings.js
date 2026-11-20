"use strict";

/**
 * Loader settings stored in the DB: the Kota_Tujuan → wilayah mapping
 * (table loader_kota_wilayah, migration 011). Mutations are audited by the
 * route layer. SiCepat credentials are deliberately NOT a setting here — they
 * stay in the user's existing rechecker token settings.
 */

const { query } = require("../db");
const { keyOf } = require("./kodepos");

function isMissingTable(err) {
  return err && (err.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(err.message || ""));
}

function badRequest(message, code) {
  const e = new Error(message);
  e.status = 400;
  e.code = code;
  return e;
}

/** [{ kota, wilayah }] for the lookup; [] when migration 011 is not applied. */
async function loadKotaMap() {
  try {
    return await query("SELECT kota, wilayah FROM loader_kota_wilayah");
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function listKotaMappings() {
  return query(
    `SELECT m.id, m.kota, m.wilayah, m.source, m.updated_at, u.username AS updated_by
       FROM loader_kota_wilayah m LEFT JOIN users u ON u.id = m.updated_by
      ORDER BY m.wilayah, m.kota`
  );
}

async function knownWilayah() {
  return (await query("SELECT DISTINCT wilayah FROM kebutuhan_loader WHERE wilayah IS NOT NULL")).map((r) => r.wilayah);
}

/**
 * Creates or updates the mapping for a kota (matched on its normalized key).
 * @returns {{ id: number, before: object|null, after: object }}
 */
async function saveKotaMapping({ kota, wilayah, userId }) {
  const cleanKota = String(kota === null || kota === undefined ? "" : kota).trim().replace(/\s+/g, " ").slice(0, 150);
  const key = keyOf(cleanKota);
  if (cleanKota.length < 3 || !key) throw badRequest("Kota_Tujuan must be at least 3 characters.", "KOTA_INVALID");
  const known = await knownWilayah();
  const match = known.find((w) => keyOf(w) === keyOf(wilayah));
  if (!match) throw badRequest("Unknown wilayah — it must exist in the kodepos reference.", "WILAYAH_UNKNOWN");

  const [existing] = await query("SELECT id, kota, wilayah, source FROM loader_kota_wilayah WHERE kota_key = ?", [key]);
  if (existing) {
    await query("UPDATE loader_kota_wilayah SET kota = ?, wilayah = ?, source = 'manual', updated_by = ? WHERE id = ?", [
      cleanKota, match, userId || null, existing.id,
    ]);
    return { id: Number(existing.id), before: { kota: existing.kota, wilayah: existing.wilayah, source: existing.source }, after: { kota: cleanKota, wilayah: match, source: "manual" } };
  }
  const r = await query(
    "INSERT INTO loader_kota_wilayah (kota, kota_key, wilayah, source, updated_by) VALUES (?, ?, ?, 'manual', ?)",
    [cleanKota, key, match, userId || null]
  );
  return { id: Number(r.insertId), before: null, after: { kota: cleanKota, wilayah: match, source: "manual" } };
}

/** @returns the deleted row, or null when not found. */
async function deleteKotaMapping(id) {
  const [row] = await query("SELECT id, kota, wilayah, source FROM loader_kota_wilayah WHERE id = ?", [Number(id)]);
  if (!row) return null;
  await query("DELETE FROM loader_kota_wilayah WHERE id = ?", [Number(id)]);
  return row;
}

module.exports = { loadKotaMap, listKotaMappings, saveKotaMapping, deleteKotaMapping, knownWilayah, isMissingTable };
