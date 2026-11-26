"use strict";

/**
 * Resi issue notes ("keterangan issue") — unit tests, no DB:
 *   - reasons: resi double (with the twin rows), invalid characters, both, none
 *   - the 3PL Loader: 409 RESI_ISSUES with reasons, red rows + cell note in the JNE file
 *   - server texts == UI dictionary (loader.resiIssue.*) in both languages
 *
 *   node tests/test-resi-issues.js
 */

const path = require("path");
const assert = require("assert");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const esbuild = require("esbuild");
const R = require("../server/loader/resiIssues");
const { precheckTemplate } = require("../server/loader/precheck");
const { processLoader } = require("../server/loader/service");
const { buildKodeposLookup } = require("../server/loader/kodepos");
const { JNE_HEADERS } = require("../server/loader/jne");

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
    }
  });
}
const section = (title) => queue.push(async () => console.log(title));
const xlsx = (aoa, sheet = "Sheet1") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

// 50 resi on Excel rows 1–50 (like "cargo garut 26 november.xlsx"):
// 4691353011 on rows 26 and 49; row 3 has "!?" typed into it.
const LIST = Array.from({ length: 50 }, (_, i) => [4692000000 + i]);
LIST[25] = [4691353011];
LIST[48] = [4691353011];
LIST[2] = ["4692000002!?"];
const listTable = (rows) => ({ headers: ["Resi"], rows, rowNumbers: rows.map((_, i) => i + 1) });
const noteOf = (analysis, row, locale = "id") => R.issueText((analysis.rows.find((r) => r.row === row) || { issues: [] }).issues, locale);

// =============================================================================
section("Reasons per row");
test("double only → 'Resi double (baris 26, 49)' on both rows", () => {
  const a = R.analyzeResi(listTable(LIST));
  assert.strictEqual(noteOf(a, 26), "Resi double (baris 26, 49)");
  assert.strictEqual(noteOf(a, 49), "Resi double (baris 26, 49)");
  assert.strictEqual(noteOf(a, 26, "en"), "Duplicate resi (rows 26, 49)");
});
test("invalid characters only → 'Karakter tidak valid: !, ? (hanya boleh angka)'", () => {
  const a = R.analyzeResi(listTable(LIST));
  assert.strictEqual(noteOf(a, 3), "Karakter tidak valid: !, ? (hanya boleh angka)");
  assert.strictEqual(noteOf(a, 3, "en"), "Invalid characters: !, ? (digits only)");
});
test("both on one row → every reason, joined", () => {
  const list = LIST.map((r) => r.slice());
  list[48] = ["4691353011!"]; // same digits as row 26 + an invalid character
  const a = R.analyzeResi(listTable(list));
  assert.strictEqual(noteOf(a, 49), "Resi double (baris 26, 49); Karakter tidak valid: ! (hanya boleh angka)");
  assert.strictEqual(noteOf(a, 26), "Resi double (baris 26, 49)");
  assert.deepStrictEqual(a.rows.find((r) => r.row === 49).issues, [{ type: "duplicate", rows: [26, 49] }, { type: "invalid", chars: ["!"] }]);
});
test("valid, unique rows have no issue and an empty note", () => {
  const a = R.analyzeResi(listTable(LIST));
  assert.deepStrictEqual(a.summary, { total: 50, valid: 47, withIssues: 3, duplicateGroups: 1, duplicateRows: 2, invalidRows: 1 });
  assert.deepStrictEqual(a.rows.find((r) => r.row === 1).issues, []);
  assert.strictEqual(noteOf(a, 1), "");
});
test("invalid characters: letters / symbols / dashes are reported; hidden characters are not", () => {
  assert.deepStrictEqual(R.invalidChars("46913A53011-"), ["A", "-"]);
  assert.deepStrictEqual(R.invalidChars("4691?35?3011"), ["?"], "each character once");
  for (const v of [4691353011, " 4691353011 ", "4691353011 ", "​4691353011", "'4691353011", "4691353011.0", "﻿4691353011"]) {
    assert.deepStrictEqual(R.invalidChars(v), [], JSON.stringify(v));
  }
});

async function readReport(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb.worksheets[0];
}
const fillOf = (c) => (c.fill && c.fill.fgColor ? c.fill.fgColor.argb : null);

section("3PL Loader: pre-check, confirmation, JNE file");
const HEADERS = [
  "Resi", "Berat", "Kode Gerai Terakhir", "Nama Gerai Terakhir", "Penerima", "No HP Penerima", "Kota_Tujuan",
  "Kecamatan Tujuan", "Alamat Penerima", "Nama Barang", "Nilai Barang", "Koli", "COD", "Biaya", "Nilai COD",
  "Status Terakhir", "Berat Asli",
];
const base = { Berat: 1, "Berat Asli": 1, COD: "COD", Biaya: 9000, "Nilai Barang": 50000, "Nilai COD": 59000, "Kecamatan Tujuan": "Cibogo", Kota_Tujuan: "Kab. Subang", "No HP Penerima": "081234567890", "Status Terakhir": "IN" };
const row = (o) => HEADERS.map((h) => (h in o ? o[h] : "x"));
// rows 2–5: 4691353011 double (2, 4), "4691353099?" invalid (3), 4691353012 valid (5)
const TPL = [row({ ...base, Resi: 4691353011 }), row({ ...base, Resi: "4691353099?" }), row({ ...base, Resi: "4691353011" }), row({ ...base, Resi: 4691353012 })];
const REF = [{ wilayah: "SUBANG", kecamatan: "Cibogo", kodepos: "41285" }];
const run = (extra) =>
  processLoader({
    templateBuffer: xlsx([HEADERS, ...TPL]), templateName: "t.xlsx",
    recheckedBuffer: xlsx([["Resi", "No HP Penerima"], [1, "0812"]]), recheckedName: "r.xlsx",
    custIdCod: "1", custIdNonCod: "2", referenceRows: REF, hubs: [], ...extra,
  });

test("pre-check: INVALID_RESI warning + every issue row with its reasons", () => {
  const pc = precheckTemplate({ headers: HEADERS, rows: TPL }, { lookupKodepos: buildKodeposLookup(REF) });
  assert.deepStrictEqual(pc.warnings.find((w) => w.code === "INVALID_RESI").items, [{ row: 3, resi: "4691353099?", chars: ["?"] }]);
  assert.deepStrictEqual(pc.resiIssues.rows.map((r) => [r.row, R.issueText(r.issues)]), [
    [2, "Resi double (baris 2, 4)"],
    [3, "Karakter tidak valid: ? (hanya boleh angka)"],
    [4, "Resi double (baris 2, 4)"],
  ]);
});
test("file mode: 409 RESI_ISSUES lists the rows and reasons (also for invalid characters alone)", async () => {
  await assert.rejects(run({ acknowledgeDuplicates: false }), (e) => {
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, "RESI_ISSUES");
    assert.deepStrictEqual(e.details.resiIssues.rows.map((r) => r.issues.map((x) => x.type)), [["duplicate"], ["invalid"], ["duplicate"]]);
    return true;
  });
  const onlyInvalid = processLoader({
    templateBuffer: xlsx([HEADERS, row({ ...base, Resi: "12-3" })]), templateName: "t.xlsx",
    recheckedBuffer: xlsx([["Resi", "No HP Penerima"], [1, "0812"]]), recheckedName: "r.xlsx",
    custIdCod: "1", custIdNonCod: "2", referenceRows: REF, hubs: [], acknowledgeDuplicates: false,
  });
  await assert.rejects(onlyInvalid, (e) => e.code === "RESI_ISSUES" && e.details.resiIssues.summary.invalidRows === 1);
});
test("JNE file: issue rows red + the reason as a note on NO RESI SICEPAT (language of the request); valid rows plain", async () => {
  for (const [locale, dup, inv] of [["id", "Resi double (baris 2, 4)", "Karakter tidak valid: ? (hanya boleh angka)"], ["en", "Duplicate resi (rows 2, 4)", "Invalid characters: ? (digits only)"]]) {
    const out = await run({ acknowledgeDuplicates: true, locale });
    assert.strictEqual(out.report.resiIssues.summary.withIssues, 3);
    const ws = await readReport(out.buffer);
    assert.strictEqual(ws.columnCount, 34, "the JNE layout keeps its 34 columns");
    const col = JNE_HEADERS.indexOf("NO RESI SICEPAT") + 1;
    const notes = {};
    ws.eachRow((r, n) => {
      if (n === 1) return;
      const c = r.getCell(col);
      const note = c.note ? (typeof c.note === "string" ? c.note : c.note.texts.map((x) => x.text).join("")) : null;
      notes[String(c.value)] = (notes[String(c.value)] || []).concat([[note, fillOf(c)]]);
    });
    assert.deepStrictEqual(notes["4691353011"], [[dup, "FFFFC7CE"], [dup, "FFFFC7CE"]], locale);
    assert.deepStrictEqual(notes["4691353099?"], [[inv, "FFFFC7CE"]], locale);
    assert.strictEqual(notes["4691353012"][0][0], null, "valid row: no note");
    assert.notStrictEqual(notes["4691353012"][0][1], "FFFFC7CE");
  }
});

section("Texts: server (Excel) == UI dictionary");
test("loader.resiIssue.* in en.ts / id.ts match the texts written into the file", () => {
  const out = esbuild.buildSync({
    stdin: { contents: "export { en } from './src/i18n/locales/en'\nexport { id } from './src/i18n/locales/id'", resolveDir: path.join(__dirname, ".."), loader: "ts" },
    bundle: true, write: false, format: "cjs", platform: "node",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  for (const lang of ["en", "id"]) {
    const ui = mod.exports[lang].loader.resiIssue;
    const srv = R.TEXT[lang];
    assert.strictEqual(ui.duplicate, srv.duplicate, `${lang} duplicate`);
    assert.strictEqual(ui.invalid, srv.invalid, `${lang} invalid`);
    assert.strictEqual(ui.separator, srv.separator, `${lang} separator`);
  }
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
