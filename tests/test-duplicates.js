"use strict";

/**
 * Resi double — unit tests (no DB):
 *   - detection before the 3PL transform (hidden spaces, number vs text, Excel rows)
 *   - the pre-check warning (API mode) lists the rows
 *   - file mode stops with 409 RESI_ISSUES until confirmed
 *   - the export paints duplicate rows red (exceljs fill / font / border)
 *
 *   node tests/test-duplicates.js
 */

const assert = require("assert");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { findDuplicateResi, resiKey } = require("../server/loader/duplicates");
const { precheckTemplate } = require("../server/loader/precheck");
const { processLoader } = require("../server/loader/service");
const { readTable, readRechecked, DUPLICATE_STYLE } = require("../server/loader/excel");
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

const HEADERS = [
  "Resi", "Berat", "Kode Gerai Terakhir", "Nama Gerai Terakhir", "Penerima", "No HP Penerima", "Kota_Tujuan",
  "Kecamatan Tujuan", "Alamat Penerima", "Nama Barang", "Nilai Barang", "Koli", "COD", "Biaya", "Nilai COD",
  "Status Terakhir", "Berat Asli",
];
const row = (o) => HEADERS.map((h) => (h in o ? o[h] : "x"));
const base = { Berat: 1, "Berat Asli": 1, COD: "COD", Biaya: 9000, "Nilai Barang": 50000, "Nilai COD": 59000, "Kecamatan Tujuan": "Cibogo", Kota_Tujuan: "Kab. Subang", "No HP Penerima": "081234567890", "Status Terakhir": "IN" };
// Excel rows 2–6: 4691353011 on rows 2 and 5 (number vs text with a hidden
// non-breaking space), 4691353012 on rows 4 and 6 (zero-width space, leading
// apostrophe); 4691353099 once.
const TEMPLATE_ROWS = [
  row({ ...base, Resi: 4691353011 }),
  row({ ...base, Resi: "4691353099" }),
  row({ ...base, Resi: "4691353012​" }),
  row({ ...base, Resi: " 4691353011 " }),
  row({ ...base, Resi: "'4691353012" }),
];
const toXlsx = (headers, rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
const REF = [{ wilayah: "SUBANG", kecamatan: "Cibogo", kodepos: "41285" }];

// =============================================================================
section("Detection (before the transform)");
test("resi 4691353011 on two rows is a duplicate, with both Excel rows", () => {
  const d = findDuplicateResi({ headers: HEADERS, rows: TEMPLATE_ROWS.slice(0, 4) });
  assert.strictEqual(d.groups, 1);
  assert.deepStrictEqual(d.items.map(({ resi, count, rows }) => ({ resi, count, rows })), [{ resi: "4691353011", count: 2, rows: [2, 5] }]);
  assert.deepStrictEqual([...d.rowSet].sort(), [2, 5]);
});
test("hidden spaces / zero-width / apostrophe / number vs text never hide a duplicate", () => {
  for (const v of [4691353011, "4691353011", " 4691353011 ", "4691353011 ", "​4691353011", "﻿4691353011", "'4691353011", "4691353011.0", "4691 353 011", "04691353011"]) {
    assert.strictEqual(resiKey(v), "4691353011", JSON.stringify(v));
  }
  const d = findDuplicateResi({ headers: HEADERS, rows: TEMPLATE_ROWS });
  assert.strictEqual(d.groups, 2);
  assert.strictEqual(d.rows, 4);
  assert.deepStrictEqual(d.items.map((i) => [i.resi, i.rows]), [["4691353011", [2, 5]], ["4691353012", [4, 6]]]);
});
test("Excel row numbers follow the sheet (title rows, blank rows); empty resi and blank rows are ignored", () => {
  const rows = [row({ ...base, Resi: "4691353011" }), HEADERS.map(() => ""), row({ ...base, Resi: "" }), row({ ...base, Resi: "4691353011" })];
  const d = findDuplicateResi({ headers: HEADERS, rows, rowNumbers: [4, 5, 6, 7] });
  assert.deepStrictEqual(d.items.map((i) => i.rows), [[4, 7]]);
  assert.strictEqual(findDuplicateResi({ headers: ["Other"], rows: [["1"], ["1"]] }).groups, 0, "no Resi column → nothing");
});
test("readTable keeps the real Excel rows (title row above the header)", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["EXPORT 3PL"], HEADERS, ...TEMPLATE_ROWS]), "Sheet1");
  const table = readTable(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), "t.xlsx", ["Resi", "Berat", "Berat Asli"]);
  assert.deepStrictEqual(findDuplicateResi(table).items.map((i) => i.rows), [[3, 6], [5, 7]]);
});

section("Pre-check (API mode) + rechecked file");
test("DUPLICATE_RESI warning lists each resi with count and rows", () => {
  const pc = precheckTemplate({ headers: HEADERS, rows: TEMPLATE_ROWS }, { lookupKodepos: buildKodeposLookup(REF) });
  const w = pc.warnings.find((x) => x.code === "DUPLICATE_RESI");
  assert.ok(w, JSON.stringify(pc.warnings));
  assert.strictEqual(w.count, 2);
  assert.deepStrictEqual(w.items, [{ resi: "4691353011", count: 2, rows: [2, 5] }, { resi: "4691353012", count: 2, rows: [4, 6] }]);
  assert.strictEqual(pc.counts.uniqueResi, 3);
});
test("rechecked file duplicates are reported with rows too", () => {
  const r = readRechecked(toXlsx(["Resi", "No HP Penerima"], [["4691353011", ""], ["4691353099", "0812"], [" 4691353011", "0813"]]), "r.xlsx");
  assert.strictEqual(r.duplicates, 1);
  assert.deepStrictEqual(r.duplicateResi.items, [{ resi: "4691353011", count: 2, rows: [2, 4] }]);
  assert.strictEqual(r.map.get("4691353011"), "0813", "first non-empty number wins");
});

section("File mode: confirmation + red rows in the export");
const run = (extra = {}) =>
  processLoader({
    templateBuffer: toXlsx(HEADERS, TEMPLATE_ROWS),
    templateName: "TEMPLATE 3PL - dup.xlsx",
    recheckedBuffer: toXlsx(["Resi", "No HP Penerima"], [[4691353011, "081234567890"]]),
    recheckedName: "r.xlsx",
    custIdCod: "82220300",
    custIdNonCod: "82220303",
    referenceRows: REF,
    hubs: [],
    ...extra,
  });
test("without confirmation → 409 RESI_ISSUES with every resi and row (nothing built)", async () => {
  await assert.rejects(run({ acknowledgeDuplicates: false }), (e) => {
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, "RESI_ISSUES");
    assert.deepStrictEqual(e.details.resiIssues.rows.map((r) => r.row), [2, 4, 5, 6]);
    assert.deepStrictEqual(e.details.duplicateResi, {
      groups: 2, rows: 4,
      items: [{ resi: "4691353011", count: 2, rows: [2, 5] }, { resi: "4691353012", count: 2, rows: [4, 6] }],
    });
    return true;
  });
});
test("a template without duplicates is never stopped", async () => {
  const out = await processLoader({
    templateBuffer: toXlsx(HEADERS, [row({ ...base, Resi: "1" }), row({ ...base, Resi: "2" })]),
    templateName: "t.xlsx", recheckedBuffer: toXlsx(["Resi", "No HP Penerima"], [[1, "0812"]]), recheckedName: "r.xlsx",
    custIdCod: "1", custIdNonCod: "2", referenceRows: REF, hubs: [], acknowledgeDuplicates: false,
  });
  assert.strictEqual(out.report.duplicateResi.groups, 0);
});
test("confirmed → all rows kept; double / invalid rows red with KETERANGAN ISSUE at the edge, valid rows plain + empty note", async () => {
  const out = await run({ acknowledgeDuplicates: true });
  assert.strictEqual(out.report.duplicateResi.groups, 2);
  assert.strictEqual(out.report.duplicateResi.highlighted, 4);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.buffer);
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.rowCount, 6, "every template row is exported");
  assert.strictEqual(ws.getRow(1).getCell(35).value, "KETERANGAN ISSUE", "issue column after CUSTOMER ID");
  const col = (h) => JNE_HEADERS.indexOf(h) + 1;
  const fillOf = (c) => (c.fill && c.fill.fgColor ? c.fill.fgColor.argb : null);
  const ZWSP = String.fromCharCode(0x200b);
  // trim() only: the NBSP-padded copy becomes the number; zero-width / apostrophe stay visible.
  const expected = new Map([
    ["4691353011", ["Resi double (baris 2, 5)", "Resi double (baris 2, 5)"]],
    ["4691353099", [""]],
    ["4691353012" + ZWSP, ["Resi double (baris 4, 6) | Karakter tidak valid: U+200B (hanya boleh angka)"]],
    ["'4691353012", ["Resi double (baris 4, 6) | Karakter tidak valid: ' (hanya boleh angka)"]],
  ]);
  const seen = new Map();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const resiCell = row.getCell(col("NO RESI SICEPAT"));
    const nameCell = row.getCell(col("NAMA PENERIMA"));
    const noteCell = row.getCell(35);
    const note = noteCell.value === null ? "" : String(noteCell.value);
    seen.set(String(resiCell.value), (seen.get(String(resiCell.value)) || []).concat(note));
    if (note) {
      for (const c of [resiCell, nameCell, noteCell]) {
        assert.strictEqual(fillOf(c), DUPLICATE_STYLE.fill, `row ${r} fill`);
        assert.strictEqual(c.font.color.argb, DUPLICATE_STYLE.font, `row ${r} font`);
        assert.strictEqual(c.border.top.color.argb, DUPLICATE_STYLE.border, `row ${r} border`);
      }
      assert.strictEqual(resiCell.font.bold, true, "resi emphasized");
      assert.strictEqual(noteCell.font.bold, true, "note emphasized");
      assert.ok(!nameCell.font.bold);
    } else {
      for (const c of [resiCell, nameCell, noteCell]) assert.notStrictEqual(fillOf(c), DUPLICATE_STYLE.fill, `row ${r} must not be red`);
    }
  }
  assert.deepStrictEqual([...seen.keys()].sort(), [...expected.keys()].sort());
  for (const [resi, notes] of expected) assert.deepStrictEqual(seen.get(resi), notes, resi);
  // The spacer column stays invisible (no red block in the separator).
  assert.notStrictEqual(fillOf(ws.getRow(2).getCell(col("SS"))), DUPLICATE_STYLE.fill);
});
test("the red style is readable: soft red fill + dark red text (Excel 'Bad' style)", () => {
  assert.deepStrictEqual(DUPLICATE_STYLE, { fill: "FFFFC7CE", font: "FF9C0006", border: "FFE06666" });
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
