"use strict";

/**
 * Data Warrior folder actions — unit tests (no DB, no R2):
 *   - bulk create from Excel: reading names (header / plain list, Excel rows),
 *     duplicate plan (in the file, already existing, invalid)
 *   - "Download all": the streaming zip writer (opens with JSZip, CRC checked,
 *     UTF-8 names, sub-folder paths, safe entry names)
 *
 *   node tests/test-folder-actions.js
 */

const assert = require("assert");
const { PassThrough } = require("stream");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const bulk = require("../server/folderBulk");
const { createZip, crc32, safeEntryName } = require("../server/zipWriter");

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
const xlsx = (aoa) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

// =============================================================================
section("Bulk create folders: reading the Excel list");
test("header 'Nama Folder' in any column; Excel row numbers kept; blank rows skipped", () => {
  const r = bulk.readFolderNames(xlsx([["DAFTAR FOLDER"], ["No", "Nama Folder"], [1, "Garut"], [2, ""], [3, "Subang"]]));
  assert.deepStrictEqual(r.names, [{ row: 3, name: "Garut" }, { row: 5, name: "Subang" }]);
});
test("plain list without header: the first column with a value, from row 1", () => {
  const r = bulk.readFolderNames(xlsx([["Garut"], ["Subang"], ["Tasik"]]));
  assert.deepStrictEqual(r.names.map((n) => [n.row, n.name]), [[1, "Garut"], [2, "Subang"], [3, "Tasik"]]);
});
test("no names / unreadable file → clear errors", () => {
  assert.throws(() => bulk.readFolderNames(xlsx([["Folder"]])), (e) => e.code === "NO_FOLDER_NAMES" && e.status === 400);
});

section("Bulk create folders: duplicates are never created");
test("duplicates inside the file (case / spaces ignored) are skipped with the row of the first one", () => {
  const plan = bulk.planFolders([
    { row: 2, name: "Garut" },
    { row: 3, name: "  garut " },
    { row: 4, name: "Subang  Kota" },
    { row: 5, name: "SUBANG KOTA" },
    { row: 6, name: "Tasik" },
  ]);
  assert.deepStrictEqual(plan.create, [{ row: 2, name: "Garut" }, { row: 4, name: "Subang Kota" }, { row: 6, name: "Tasik" }]);
  assert.deepStrictEqual(plan.skipped, [
    { row: 3, name: "garut", reason: "duplicate_in_file", firstRow: 2 },
    { row: 5, name: "SUBANG KOTA", reason: "duplicate_in_file", firstRow: 4 },
  ]);
});
test("names already in the target folder are skipped (case-insensitive)", () => {
  const plan = bulk.planFolders([{ row: 2, name: "Garut" }, { row: 3, name: "Baru" }], ["GARUT", "Lain"]);
  assert.deepStrictEqual(plan.create, [{ row: 3, name: "Baru" }]);
  assert.deepStrictEqual(plan.skipped, [{ row: 2, name: "Garut", reason: "exists" }]);
});
test("invalid names (too long / line breaks) are skipped, not created", () => {
  const plan = bulk.planFolders([{ row: 2, name: "x".repeat(192) }, { row: 3, name: "a\nb" }, { row: 4, name: "Ok" }]);
  assert.deepStrictEqual(plan.skipped.map((s) => [s.row, s.reason]), [[2, "invalid"], [3, "invalid"]]);
  assert.deepStrictEqual(plan.create.map((c) => c.name), ["Ok"]);
});
test(`more than ${bulk.MAX_FOLDERS} names → refused`, () => {
  const many = Array.from({ length: bulk.MAX_FOLDERS + 1 }, (_, i) => ({ row: i + 1, name: `F${i}` }));
  assert.throws(() => bulk.planFolders(many), (e) => e.code === "TOO_MANY_FOLDERS");
});

// =============================================================================
section("Download all: zip writer");
async function zipOf(entries) {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  const zip = createZip(out);
  for (const [name, data] of entries) await zip.addFile(name, data, { date: new Date(2026, 10, 27, 10, 30, 0) });
  const info = await zip.finish();
  out.end();
  return { buf: Buffer.concat(chunks), info };
}
test("valid zip: sub-folder paths, UTF-8 names, exact contents (JSZip checks CRC)", async () => {
  const pdf = Buffer.from("%PDF-1.4 fake");
  const big = Buffer.alloc(300000, 7);
  const { Readable } = require("stream");
  const { buf, info } = await zipOf([
    ["Garut/laporan.pdf", pdf],
    ["Garut/Sub A/foto ü.jpg", Readable.from([Buffer.from("abc"), Buffer.from("def")])],
    ["Garut/big.bin", big],
  ]);
  assert.strictEqual(info.files, 3);
  const z = await JSZip.loadAsync(buf, { checkCRC32: true });
  assert.deepStrictEqual(Object.keys(z.files).filter((n) => !z.files[n].dir).sort(), ["Garut/Sub A/foto ü.jpg", "Garut/big.bin", "Garut/laporan.pdf"]);
  assert.strictEqual((await z.file("Garut/laporan.pdf").async("nodebuffer")).toString(), "%PDF-1.4 fake");
  assert.strictEqual(await z.file("Garut/Sub A/foto ü.jpg").async("string"), "abcdef");
  assert.ok((await z.file("Garut/big.bin").async("nodebuffer")).equals(big));
  assert.strictEqual(z.file("Garut/laporan.pdf").date.getFullYear(), 2026);
});
test("CRC-32 matches the standard check value", () => {
  assert.strictEqual(crc32(Buffer.from("123456789")).toString(16), "cbf43926");
});
test("entry names cannot escape the archive (.., absolute paths, reserved characters)", () => {
  assert.strictEqual(safeEntryName("../../etc/passwd"), "etc/passwd");
  assert.strictEqual(safeEntryName("/abs\\win\\file.txt"), "abs/win/file.txt");
  assert.strictEqual(safeEntryName('a:b*c?.pdf'), "a_b_c_.pdf");
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
