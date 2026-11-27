"use strict";

/**
 * Loader orchestration: read inputs → load kodepos reference → run Rules
 * 1–15 → write the styled workbook (Rule 16). Pure apart from the
 * reference loader, which is injectable for tests.
 */

const path = require("path");
const { transformTemplate, LoaderInputError } = require("./transform");
const { readTable, readRechecked, writeWorkbook } = require("./excel");
const { buildKodeposLookup, loadReference } = require("./kodepos");
const { loadKotaMap } = require("./settings");
const { buildHubLookup, loadHubs } = require("./hubs");
const { buildJneSheet, JNE_SHEET, JNE_SHEET_STYLE, ISSUE_HEADER_FILL } = require("./jne");
const { findDuplicateResi, summarizeDuplicates } = require("./duplicates");
const { analyzeResi, issueText, phoneIssueText, TEXT: ISSUE_TEXT, localeOf } = require("./resiIssues");

const ISSUE_LIST_CAP = 500;
/** Rows with a resi issue, JSON-safe (UI panel + 409 details). */
function issuesView(analysis) {
  const rows = analysis.rows.filter((r) => r.issues.length);
  return { summary: analysis.summary, rows: rows.slice(0, ISSUE_LIST_CAP), truncated: rows.length > ISSUE_LIST_CAP };
}
const { config } = require("../config");

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

/** Reference rows + Kota_Tujuan mapping + gerai/HUB master (injectable for tests). */
async function loadLookupData({ referenceRows = null, kotaMap = null, hubs = null } = {}) {
  const reference = referenceRows || (await loadReference());
  if (!reference.length) {
    throw new LoaderInputError(
      "The kodepos reference (kebutuhan_loader) is empty. Import the master file first.",
      "REFERENCE_EMPTY"
    );
  }
  // Tests inject referenceRows without a DB → mapping defaults to none.
  const mapping = kotaMap || (referenceRows ? [] : await loadKotaMap());
  const hubRows = hubs || (referenceRows ? [] : await loadHubs());
  return { reference, kotaMap: mapping, hubs: hubRows };
}

/** The kodepos lookup used by both the pre-check and the run. */
function makeLookup({ reference, kotaMap, wilayah }) {
  return buildKodeposLookup(reference, { wilayah, kotaMap });
}

/**
 * Rules 1–16 for an already-read template, with the phone source given as a
 * Map (normalized resi → phone) — from a rechecked file OR from the API queue.
 */
async function buildLoaderFile({
  table, templateName, rechecked, recheckedMeta, ids, wilayah, reference, kotaMap,
  hubs = [], convertWeight = true, senderPhone = config.loader.senderPhone, date, sender = null,
  locale = "id", // language of the issue notes in the file
}) {
  // Resi double: detected on the template BEFORE the transform (Excel row
  // numbers); the rows stay in the file but are painted red.
  const duplicates = findDuplicateResi(table);
  // Every resi issue (double and/or invalid characters) → red row + reason note.
  const issues = analyzeResi(table);
  const issueRows = new Set(issues.byRow.keys());
  const rowNotes = new Map([...issues.byRow].map(([n, list]) => [n, issueText(list, locale)]));
  const result = transformTemplate(table, {
    rechecked,
    convertWeight: convertWeight !== false,
    lookupKodepos: makeLookup({ reference, kotaMap, wilayah }),
    custIdCod: ids.cod,
    custIdNonCod: ids.nonCod,
  });
  // The download is ONLY the Loader JNE layout (34 columns). The transformed
  // rows (TAMPILAN FINAL shape) are an intermediate step and never exported.
  const jne = buildJneSheet(result, {
    lookupKotaPenerima: buildHubLookup(hubs),
    senderPhone,
    service: config.loader.jneService,
    sender,
    duplicateRows: issueRows,
    rowNotes,
    issueHeader: ISSUE_TEXT[localeOf(locale)].column,
    phoneNote: (issue) => phoneIssueText(issue, locale),
    ...(date ? { date } : {}),
  });
  const buffer = await writeWorkbook([{
    name: JNE_SHEET, headers: jne.headers, rows: jne.rows, ...JNE_SHEET_STYLE,
    // The issue column's header is red too: it is not part of the JNE layout.
    headerFills: { ...JNE_SHEET_STYLE.headerFills, [jne.issueHeader]: ISSUE_HEADER_FILL },
    highlightRows: jne.highlightRows, emphasizeColumns: ["NO RESI SICEPAT", "ORDER ID / REFERENCE NUMBER", jne.issueHeader],
  }]);
  return {
    buffer,
    filename: outputFileName(templateName),
    headers: jne.headers, // 34 JNE columns + KETERANGAN ISSUE
    report: {
      ...result.report,
      kotaPenerima: jne.report,
      // DESKRIPSI BARANG blank → PAKET; rows kept with an invalid / missing phone (red + note).
      deskripsiDefaulted: jne.stats.deskripsiDefaulted,
      phoneIssueRows: jne.stats.phoneIssueRows,
      sheets: [JNE_SHEET],
      senderPhone,
      columns: jne.headers, // the 34 JNE columns + the issue note column
      template: { name: templateName, sheet: table.sheetName },
      rechecked: recheckedMeta,
      wilayah: wilayah || null,
      // Wilayah / kota picked in the form and the sender columns they produce.
      sender: sender || null,
      // Template rows sharing a resi (painted red in the file).
      duplicateResi: { ...summarizeDuplicates(duplicates), highlighted: jne.highlightRows.size },
      // Per row: double and/or invalid characters (structured; texts per language in the UI).
      resiIssues: issuesView(issues),
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
  hubs = null, // gerai/HUB master (KOTA PENERIMA); DB otherwise
  convertWeight = true, // Rule 4 switch: Berat from Berat Asli
  sender = null, // KOTA PENGIRIM / NAMA PENGIRIM from the wilayah + kota (wilayah.js)
  acknowledgeDuplicates = true, // false → resi issues stop the run (409) until confirmed
  locale = "id",
}) {
  const ids = validateCustIds(custIdCod, custIdNonCod);
  const table = readTemplate(templateBuffer, templateName);
  assertNoUnconfirmedDuplicates(table, acknowledgeDuplicates);
  const rechecked = readRechecked(recheckedBuffer, recheckedName);
  const { reference, kotaMap: mapping, hubs: hubRows } = await loadLookupData({ referenceRows, kotaMap, hubs });
  return buildLoaderFile({
    table,
    templateName,
    rechecked: rechecked.map,
    recheckedMeta: { mode: "file", name: recheckedName, sheet: rechecked.sheetName, rows: rechecked.rows, duplicates: rechecked.duplicates, duplicateResi: rechecked.duplicateResi },
    ids,
    wilayah,
    reference,
    kotaMap: mapping,
    hubs: hubRows,
    convertWeight,
    sender,
    locale,
  });
}

/**
 * Pre-check before the 3PL transform: resi double in the template must be
 * confirmed by the operator. 409 DUPLICATE_RESI carries every duplicate resi
 * with its Excel rows (details.duplicateResi) for the red warning in the UI.
 */
function assertNoUnconfirmedDuplicates(table, acknowledged) {
  if (acknowledged) return;
  const issues = analyzeResi(table);
  if (!issues.summary.withIssues) return;
  const err = new LoaderInputError("The template has resi issues (double or invalid characters). Review them and confirm to continue.", "RESI_ISSUES", {
    duplicateResi: summarizeDuplicates(findDuplicateResi(table)),
    resiIssues: issuesView(issues),
  });
  err.status = 409;
  throw err;
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
  assertNoUnconfirmedDuplicates,
  issuesView,
};
