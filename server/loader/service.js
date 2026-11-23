"use strict";

/**
 * Loader orchestration: read inputs → load kodepos reference → run Rules
 * 1–15 → write the styled workbook (Rule 16). Pure apart from the
 * reference loader, which is injectable for tests.
 */

const path = require("path");
const { transformTemplate, LoaderInputError } = require("./transform");
const { readTable, readRechecked, writeLoaderWorkbook } = require("./excel");
const { buildKodeposLookup, loadReference } = require("./kodepos");
const { loadKotaMap } = require("./settings");

// Digits only, ≤ 15 (CUST ID is written as an Excel number; 15 digits keep full precision).
const CUST_ID_RE = /^\d{1,15}$/;

function validateCustIds(custIdCod, custIdNonCod) {
  const cod = String(custIdCod === null || custIdCod === undefined ? "" : custIdCod).trim();
  const nonCod = String(custIdNonCod === null || custIdNonCod === undefined ? "" : custIdNonCod).trim();
  if (!cod || !nonCod) {
    throw new LoaderInputError("Both cust IDs (COD and Non-COD) are required.", "CUST_ID_REQUIRED");
  }
  if (!CUST_ID_RE.test(cod) || !CUST_ID_RE.test(nonCod)) {
    throw new LoaderInputError("Cust ID must be a number (digits only, max 15).", "CUST_ID_INVALID");
  }
  if (cod === nonCod) {
    throw new LoaderInputError("The COD and Non-COD cust IDs must be different.", "CUST_ID_SAME");
  }
  return { cod, nonCod };
}

/** "TEMPLATE 3PL - 2026-11-20T124928.943.xlsx" → "LOADER - TEMPLATE 3PL - 2026-11-20T124928.943.xlsx" */
function outputFileName(templateName) {
  const base = path.basename(String(templateName || "template")).replace(/\.(xlsx|xls)$/i, "");
  const safe = base.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 120) || "template";
  return `LOADER - ${safe}.xlsx`;
}

/** Reference rows + Kota_Tujuan mapping (injectable for tests). */
async function loadLookupData({ referenceRows = null, kotaMap = null } = {}) {
  const reference = referenceRows || (await loadReference());
  if (!reference.length) {
    throw new LoaderInputError(
      "The kodepos reference (kebutuhan_loader) is empty. Import the master file first.",
      "REFERENCE_EMPTY"
    );
  }
  // Tests inject referenceRows without a DB → mapping defaults to none.
  const mapping = kotaMap || (referenceRows ? [] : await loadKotaMap());
  return { reference, kotaMap: mapping };
}

/** The kodepos lookup used by both the pre-check and the run. */
function makeLookup({ reference, kotaMap, wilayah }) {
  return buildKodeposLookup(reference, { wilayah, kotaMap });
}

/**
 * Rules 1–16 for an already-read template, with the phone source given as a
 * Map (normalized resi → phone) — from a rechecked file OR from the API queue.
 */
async function buildLoaderFile({ table, templateName, rechecked, recheckedMeta, ids, wilayah, reference, kotaMap, convertWeight = true }) {
  const result = transformTemplate(table, {
    rechecked,
    convertWeight: convertWeight !== false,
    lookupKodepos: makeLookup({ reference, kotaMap, wilayah }),
    custIdCod: ids.cod,
    custIdNonCod: ids.nonCod,
  });
  const buffer = await writeLoaderWorkbook(result.headers, result.rows);
  return {
    buffer,
    filename: outputFileName(templateName),
    headers: result.headers,
    report: {
      ...result.report,
      columns: result.headers,
      template: { name: templateName, sheet: table.sheetName },
      rechecked: recheckedMeta,
      wilayah: wilayah || null,
      referenceRows: reference.length,
    },
  };
}

/** Reads the 3PL template (header detection) — shared by both modes. */
function readTemplate(templateBuffer, templateName) {
  return readTable(templateBuffer, templateName, ["Resi", "Berat", "Berat Asli"]);
}

/**
 * File mode: template + rechecked Excel → loader file.
 * @returns {Promise<{buffer: Buffer, filename: string, report: object}>}
 */
async function processLoader({
  templateBuffer,
  templateName,
  recheckedBuffer,
  recheckedName,
  custIdCod,
  custIdNonCod,
  wilayah = null,
  referenceRows = null, // injected in tests; DB otherwise
  kotaMap = null,
  convertWeight = true, // Rule 4 switch: Berat from Berat Asli
}) {
  const ids = validateCustIds(custIdCod, custIdNonCod);
  const table = readTemplate(templateBuffer, templateName);
  const rechecked = readRechecked(recheckedBuffer, recheckedName);
  const { reference, kotaMap: mapping } = await loadLookupData({ referenceRows, kotaMap });
  return buildLoaderFile({
    table,
    templateName,
    rechecked: rechecked.map,
    recheckedMeta: { mode: "file", name: recheckedName, sheet: rechecked.sheetName, rows: rechecked.rows, duplicates: rechecked.duplicates },
    ids,
    wilayah,
    reference,
    kotaMap: mapping,
    convertWeight,
  });
}

/** Request body → Rule 4 switch. Missing = ON (previous behaviour); only an explicit false/"false"/0 turns it off. */
function convertWeightOf(body) {
  const v = body ? body.convertWeightFromActual : undefined;
  return !(v === false || v === "false" || v === 0 || v === "0");
}

module.exports = {
  processLoader,
  convertWeightOf,
  buildLoaderFile,
  readTemplate,
  loadLookupData,
  makeLookup,
  validateCustIds,
  outputFileName,
};
