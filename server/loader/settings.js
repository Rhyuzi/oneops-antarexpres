"use strict";

/**
 * Loader settings stored in the DB: the Kota_Tujuan → wilayah mapping
 * (table loader_kota_wilayah, migration 011). READ-ONLY here: create / edit /
 * delete / import live in Master Data (server/masterData/service.js). SiCepat credentials are deliberately NOT a setting here — they
 * stay in the user's existing rechecker token settings.
 */

const { query } = require("../db");

function isMissingTable(err) {
  return err && (err.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(err.message || ""));
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

module.exports = { loadKotaMap, listKotaMappings, knownWilayah, isMissingTable };
