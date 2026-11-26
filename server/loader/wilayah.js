"use strict";

/**
 * Wilayah master (migration 014) as used by the 3PL Loader.
 *
 *   master_wilayah       ← master_cust_id      (wilayah_id FK, one row)
 *                        ← master_wilayah_kota (wilayah_id FK, breakdown kota)
 *
 * The Loader form sends { wilayahId, kotaId } only. The server resolves
 * everything else from the DB, so the read-only Cust ID inputs in the UI are
 * a display, never an input:
 *   - Cust IDs        CUSTOMER ID per row (N = Non-COD, Y = COD)
 *   - kodeposWilayah  scopes the kodepos lookup (kebutuhan_loader.wilayah)
 *   - KOTA PENGIRIM   the kota's own kota_pengirim when set (migration 015,
 *                     e.g. Tasikmalaya: Mangkubumi / Singaparna / Sukaraja →
 *                     "Tasikmalaya", Ciamis → "Ciamis"); otherwise "" for
 *                     Tasikmalaya and the wilayah name for every other wilayah
 *   - NAMA PENGIRIM   "<nama_pengirim_base> <kota>" (spaces collapsed);
 *                     base NULL → "SICEPAT <WILAYAH NAME>"
 *
 * Pure helpers (senderFor, isTasikmalaya, kotaMatches, …) are unit-tested in
 * tests/test-wilayah.js; the DB parts in tests/live-wilayah.test.js.
 */

const { query } = require("../db");
const { LoaderInputError } = require("./transform");

const keyOf = (s) => String(s === null || s === undefined ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
const squash = (s) => String(s === null || s === undefined ? "" : s).replace(/\s+/g, " ").trim();

const TASIKMALAYA_KEYS = new Set(["tasikmalaya", "tasik"]);

/** Tasikmalaya by name or by kodepos code, case/space-insensitive. */
function isTasikmalaya(wilayah) {
  if (!wilayah) return false;
  return TASIKMALAYA_KEYS.has(keyOf(wilayah.name)) || TASIKMALAYA_KEYS.has(keyOf(wilayah.kodepos_wilayah));
}

function defaultNamaPengirimBase(name) {
  return `SICEPAT ${squash(name).toUpperCase()}`.trim();
}

/**
 * Sender columns of the JNE file for a wilayah + breakdown kota.
 * @param {{name: string, kodepos_wilayah?: string|null, nama_pengirim_base?: string|null}} wilayah
 * @param {{kota: string, kota_pengirim?: string|null}} kota
 */
function kotaPengirimFor(wilayah, kota) {
  const own = squash(kota && kota.kota_pengirim);
  if (own) return own; // configured per kota in Master Data
  return isTasikmalaya(wilayah) ? "" : squash(wilayah.name);
}

function senderFor(wilayah, kota) {
  const base = squash(wilayah.nama_pengirim_base) || defaultNamaPengirimBase(wilayah.name);
  return {
    // Independent of NAMA PENGIRIM, which always appends the kota NAME.
    kotaPengirim: kotaPengirimFor(wilayah, kota),
    namaPengirim: squash(`${base} ${kota ? kota.kota : ""}`),
  };
}

/** Aliases column → normalized list ("Sukareja, sukaréja" → ["sukareja", …]). */
function aliasList(aliases) {
  return String(aliases || "")
    .split(/[,;]/)
    .map((a) => squash(a))
    .filter(Boolean);
}

/** Search a kota by its name or an alias (case/space/punctuation-insensitive, partial). */
function kotaMatches(row, term) {
  const q = keyOf(term);
  if (!q) return true;
  return [row.kota, ...aliasList(row.aliases)].some((v) => keyOf(v).includes(q));
}

/** Cust ID column value → digits string ("82191603"); null when unusable. */
function custIdText(v) {
  const s = String(v === null || v === undefined ? "" : v).trim();
  return /^\d{1,15}$/.test(s) ? s : null;
}

// --- DB -------------------------------------------------------------------------------------

/** Every wilayah with its cust IDs and kota (Loader form + read-only view). */
async function loadWilayahOptions() {
  const wilayah = await query(
    `SELECT w.id, w.name, w.kodepos_wilayah, w.nama_pengirim_base,
            c.cust_id_non_cod, c.cust_id_cod
       FROM master_wilayah w
       LEFT JOIN master_cust_id c ON c.wilayah_id = w.id
      ORDER BY w.name`
  );
  const kota = await query("SELECT id, wilayah_id, kota, aliases, kota_pengirim FROM master_wilayah_kota ORDER BY kota");
  return wilayah.map((w) => ({
    id: Number(w.id),
    name: w.name,
    kodeposWilayah: w.kodepos_wilayah || null,
    namaPengirimBase: squash(w.nama_pengirim_base) || defaultNamaPengirimBase(w.name),
    custIdNonCod: custIdText(w.cust_id_non_cod),
    custIdCod: custIdText(w.cust_id_cod),
    isTasikmalaya: isTasikmalaya(w),
    kota: kota
      .filter((k) => Number(k.wilayah_id) === Number(w.id))
      .map((k) => ({ id: Number(k.id), kota: k.kota, aliases: aliasList(k.aliases), kotaPengirim: kotaPengirimFor(w, k) })),
  }));
}

const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Resolves the Loader request ({ wilayahId, kotaId }) against the DB.
 * requireKota = false for the pre-check (only the kodepos scope is needed).
 * @returns {Promise<{wilayah: object, kota: object|null, ids: {cod: string, nonCod: string}|null, kodeposWilayah: string|null, sender: object|null}>}
 */
async function resolveLoaderContext(body, { requireKota = true } = {}) {
  const b = body || {};
  const wilayahId = idOf(b.wilayahId);
  if (!wilayahId) throw new LoaderInputError("Choose a wilayah.", "WILAYAH_REQUIRED");
  const [w] = await query(
    `SELECT w.id, w.name, w.kodepos_wilayah, w.nama_pengirim_base, c.cust_id_non_cod, c.cust_id_cod
       FROM master_wilayah w LEFT JOIN master_cust_id c ON c.wilayah_id = w.id
      WHERE w.id = ?`,
    [wilayahId]
  );
  if (!w) throw new LoaderInputError("The selected wilayah does not exist in Master Data.", "WILAYAH_UNKNOWN");

  const kotaId = idOf(b.kotaId);
  let kota = null;
  if (kotaId) {
    [kota] = await query("SELECT id, wilayah_id, kota, kota_pengirim FROM master_wilayah_kota WHERE id = ?", [kotaId]);
    if (!kota || Number(kota.wilayah_id) !== Number(w.id)) {
      throw new LoaderInputError("The selected kota does not belong to the selected wilayah.", "KOTA_MISMATCH");
    }
  } else if (requireKota) {
    throw new LoaderInputError("Choose a kota for the selected wilayah.", "KOTA_REQUIRED");
  }

  let ids = null;
  if (requireKota) {
    const nonCod = custIdText(w.cust_id_non_cod);
    const cod = custIdText(w.cust_id_cod);
    if (!nonCod || !cod) {
      throw new LoaderInputError("No cust IDs are set for this wilayah. Add them in Master Data → Cust ID.", "CUST_ID_MISSING");
    }
    ids = { cod, nonCod };
  }
  return {
    wilayah: { id: Number(w.id), name: w.name, kodepos_wilayah: w.kodepos_wilayah || null },
    kota: kota ? { id: Number(kota.id), kota: kota.kota } : null,
    ids,
    kodeposWilayah: w.kodepos_wilayah || null,
    sender: kota ? { wilayah: w.name, kota: kota.kota, ...senderFor(w, kota) } : null,
  };
}

function isMissingTable(err) {
  return err && (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146);
}

module.exports = {
  keyOf,
  isTasikmalaya,
  defaultNamaPengirimBase,
  senderFor,
  kotaPengirimFor,
  aliasList,
  kotaMatches,
  custIdText,
  loadWilayahOptions,
  resolveLoaderContext,
  isMissingTable,
};
