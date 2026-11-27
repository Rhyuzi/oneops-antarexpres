"use strict";

/**
 * 3PL Loader enhancements — unit tests (no DB):
 *   1. Berat 0 / empty → 1          2. invalid / missing phone: row kept, red, note
 *   3. DESKRIPSI BARANG blank → PAKET
 *   4–6. CATEGORY / KOTA PENGIRIM / NAMA PENGIRIM centred
 *   7. TGL DROP = Date (dd/mm/yyyy), centred
 *   8. KODE POS PENERIMA: template kodepos column, kecamatan variants,
 *      5-digit kodepos in the address (incl. Tasikmalaya cases)
 *
 *   node tests/test-loader-enhancements.js
 */

const assert = require("assert");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const { processLoader } = require("../server/loader/service");
const { buildKodeposLookup, kecamatanVariants, kodeposFromText } = require("../server/loader/kodepos");
const { transformTemplate } = require("../server/loader/transform");
const { JNE_HEADERS } = require("../server/loader/jne");
const { senderFor } = require("../server/loader/wilayah");

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
const base = {
  Berat: 1, "Berat Asli": 1, COD: "COD", Biaya: 9000, "Nilai Barang": 50000, "Nilai COD": 59000, Penerima: "A",
  "Kecamatan Tujuan": "Cihideung", Kota_Tujuan: "Kota Tasikmalaya", "Alamat Penerima": "Jl. X", "Nama Barang": "Baju",
  "No HP Penerima": "081234567890", "Status Terakhir": "IN",
};
const row = (o, headers = HEADERS) => headers.map((h) => (h in o ? o[h] : "x"));
const xlsx = (aoa) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
// TASIK: Cihideung unique; Tamansari has two kodepos in TASIK; Kawalu unique.
const REF = [
  { wilayah: "TASIK", kecamatan: "Cihideung", kodepos: "46121" },
  { wilayah: "TASIK", kecamatan: "Tamansari", kodepos: "46191" },
  { wilayah: "TASIK", kecamatan: "Tamansari", kodepos: "46196" },
  { wilayah: "TASIK", kecamatan: "Kawalu", kodepos: "46182" },
  { wilayah: "SUBANG", kecamatan: "Cibogo", kodepos: "41285" },
];
const TASIK = { name: "Tasikmalaya", kodepos_wilayah: "TASIK", nama_pengirim_base: "SICEPAT TASIKMALAYA" };

async function run(rows, { headers = HEADERS, convertWeight = true, rechecked = null, locale = "id" } = {}) {
  const res = await processLoader({
    templateBuffer: xlsx([headers, ...rows]),
    templateName: "t.xlsx",
    recheckedBuffer: xlsx([["Resi", "No HP Penerima"], ...(rechecked || [])]),
    recheckedName: "r.xlsx",
    custIdCod: "82191600",
    custIdNonCod: "82191603",
    wilayah: "TASIK",
    referenceRows: REF,
    hubs: [],
    convertWeight,
    locale,
    sender: { wilayah: "Tasikmalaya", kota: "Sukaraja", ...senderFor(TASIK, { kota: "Sukaraja", kota_pengirim: "Tasikmalaya" }) },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.buffer);
  const ws = wb.worksheets[0];
  const out = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const o = { __row: r };
    [...JNE_HEADERS, "ISSUE"].forEach((h, i) => (o[h] = r.getCell(i + 1).value));
    out.push(o);
  });
  return { report: res.report, rows: out, ws };
}
const byResi = (rows, resi) => rows.find((r) => String(r["NO RESI SICEPAT"]) === String(resi));
const col = (h) => JNE_HEADERS.indexOf(h) + 1;
const fillOf = (c) => (c.fill && c.fill.fgColor ? c.fill.fgColor.argb : null);

// =============================================================================
section("1. Berat 0 / empty → 1");
test("Berat 0 and empty become 1 (switch on and off); other weights unchanged; counted", async () => {
  for (const convertWeight of [true, false]) {
    const { rows, report } = await run([
      row({ ...base, Resi: "11", Berat: 0, "Berat Asli": 0 }),
      row({ ...base, Resi: "12", Berat: "", "Berat Asli": 0.4 }),
      row({ ...base, Resi: "13", Berat: 0, "Berat Asli": 0.6 }), // Berat Asli heavier: still 1, never 0.6
      row({ ...base, Resi: "14", Berat: 3, "Berat Asli": 3 }),
    ], { convertWeight });
    assert.deepStrictEqual(["11", "12", "13", "14"].map((r) => byResi(rows, r)["BERAT/KG"]), [1, 1, 1, 3], `convert ${convertWeight}`);
    assert.strictEqual(report.weight.zeroToOne, 3);
    assert.deepStrictEqual(report.weight.invalid, []);
  }
});
test("non-numeric Berat is still reported, not replaced", () => {
  const out = transformTemplate({ headers: HEADERS, rows: [row({ ...base, Resi: "1", Berat: "abc" })] }, {
    rechecked: new Map(), lookupKodepos: buildKodeposLookup(REF), custIdCod: "1", custIdNonCod: "2", convertWeight: false,
  });
  assert.strictEqual(out.report.weight.zeroToOne, 0);
  assert.strictEqual(out.report.weight.invalid.length, 1);
});

section("2. Invalid / missing phone: row kept + red + note");
test("rows with an invalid or empty phone stay in the file, red, with the reason in KETERANGAN ISSUE", async () => {
  const { rows, report } = await run([
    row({ ...base, Resi: "21", "No HP Penerima": "081234567890" }),
    row({ ...base, Resi: "22", "No HP Penerima": "12345" }),
    row({ ...base, Resi: "23", "No HP Penerima": "" }),
  ]);
  assert.strictEqual(rows.length, 3, "no row dropped");
  assert.strictEqual(report.phoneIssueRows, 2);
  assert.strictEqual(report.phone.invalid.length, 2);
  const ok = byResi(rows, "21");
  assert.strictEqual(ok.ISSUE, null);
  assert.notStrictEqual(fillOf(ok.__row.getCell(col("NO RESI SICEPAT"))), "FFFFC7CE");
  for (const [resi, note] of [["22", "No HP penerima tidak valid"], ["23", "No HP penerima kosong"]]) {
    const r = byResi(rows, resi);
    assert.strictEqual(r.ISSUE, note, resi);
    assert.strictEqual(fillOf(r.__row.getCell(col("NO HANDPHONE PENERIMA"))), "FFFFC7CE", `${resi} red`);
  }
});
test("phone note joins the resi notes with ' | ' and follows the language", async () => {
  const { rows } = await run([
    row({ ...base, Resi: "31!", "No HP Penerima": "999" }),
  ], { locale: "en" });
  assert.strictEqual(rows[0].ISSUE, "Invalid characters: ! (digits only) | Invalid recipient phone number");
});

section("3. DESKRIPSI BARANG blank → PAKET");
test("null / empty / spaces → PAKET; a real description is kept; counted", async () => {
  const headersNoX = HEADERS;
  const { rows, report } = await run([
    row({ ...base, Resi: "41", "Nama Barang": "" }),
    row({ ...base, Resi: "42", "Nama Barang": "   " }),
    row({ ...base, Resi: "43", "Nama Barang": "Sepatu" }),
  ], { headers: headersNoX });
  assert.deepStrictEqual(["41", "42", "43"].map((r) => byResi(rows, r)["DESKRIPSI BARANG"]), ["PAKET", "PAKET", "Sepatu"]);
  assert.strictEqual(report.deskripsiDefaulted, 2);
});

section("4–7. Alignment + TGL DROP date");
test("CATEGORY, KOTA PENGIRIM, NAMA PENGIRIM and TGL DROP data cells are centred; others are not", async () => {
  const { rows } = await run([row({ ...base, Resi: "51" })]);
  const r = rows[0].__row;
  for (const h of ["CATEGORY", "KOTA PENGIRIM", "NAMA PENGIRIM", "TGL DROP"]) {
    assert.strictEqual(r.getCell(col(h)).alignment && r.getCell(col(h)).alignment.horizontal, "center", h);
  }
  for (const h of ["NAMA PENERIMA", "ALAMAT PENERIMA"]) {
    assert.ok(!r.getCell(col(h)).alignment || r.getCell(col(h)).alignment.horizontal !== "center", h);
  }
  assert.deepStrictEqual([rows[0]["KOTA PENGIRIM"], rows[0]["NAMA PENGIRIM"], rows[0].CATEGORY], ["Tasikmalaya", "SICEPAT TASIKMALAYA Sukaraja", "COD"]);
});
test("TGL DROP is a real Date with a dd/mm/yyyy format", async () => {
  const { rows } = await run([row({ ...base, Resi: "61" })]);
  const c = rows[0].__row.getCell(col("TGL DROP"));
  assert.ok(c.value instanceof Date && !Number.isNaN(c.value.getTime()), `value ${c.value}`);
  assert.strictEqual(c.numFmt, "dd/mm/yyyy");
});

section("8. KODE POS PENERIMA (Tasikmalaya)");
test("kecamatan written with its city ('Cihideung, Kota Tasikmalaya', 'Kawalu Kota Tasikmalaya') still resolves", async () => {
  assert.deepStrictEqual(kecamatanVariants("Cihideung, Kota Tasikmalaya"), ["Cihideung"]);
  assert.deepStrictEqual(kecamatanVariants("Kawalu Kota Tasikmalaya"), ["Kawalu"]);
  const { rows, report } = await run([
    row({ ...base, Resi: "71", "Kecamatan Tujuan": "Cihideung, Kota Tasikmalaya" }),
    row({ ...base, Resi: "72", "Kecamatan Tujuan": "Kawalu Kota Tasikmalaya" }),
    row({ ...base, Resi: "73", "Kecamatan Tujuan": "Kec. Cihideung" }),
  ]);
  assert.deepStrictEqual(["71", "72", "73"].map((r) => byResi(rows, r)["KODE POS PENERIMA"]), [46121, 46182, 46121]);
  assert.strictEqual(report.kodepos.filled, 3);
});
test("ambiguous kecamatan (Tamansari 46191 / 46196) is settled by a 5-digit kodepos in the address", async () => {
  const { rows, report } = await run([
    row({ ...base, Resi: "81", "Kecamatan Tujuan": "Tamansari", "Alamat Penerima": "Jl. Mangin No. 5 RT 01 Tamansari Tasikmalaya 46196" }),
    row({ ...base, Resi: "82", "Kecamatan Tujuan": "Tamansari", "Alamat Penerima": "Jl. Mangin No. 5" }),
  ]);
  assert.strictEqual(byResi(rows, "81")["KODE POS PENERIMA"], 46196);
  assert.strictEqual(byResi(rows, "82")["KODE POS PENERIMA"], null, "still ambiguous: never guessed");
  assert.strictEqual(report.kodepos.fromAddress, 1);
  assert.strictEqual(report.kodepos.ambiguous.length, 1);
});
test("unknown kecamatan: a kodepos from the reference found in the address is used; unknown numbers are not", async () => {
  const { rows } = await run([
    row({ ...base, Resi: "91", "Kecamatan Tujuan": "Indihiang Baru", "Alamat Penerima": "Perum X Blok 12345, Kawalu 46182" }),
    row({ ...base, Resi: "92", "Kecamatan Tujuan": "Indihiang Baru", "Alamat Penerima": "Gang 12345" }),
  ]);
  assert.strictEqual(byResi(rows, "91")["KODE POS PENERIMA"], 46182);
  assert.strictEqual(byResi(rows, "92")["KODE POS PENERIMA"], null);
  assert.deepStrictEqual(kodeposFromText("No 123456 / 46182 / 4618"), ["46182"]);
});
test("the template's own kodepos column (5 digits) wins over the reference", async () => {
  const headers = [...HEADERS, "Kode Pos"];
  const { rows, report } = await run([
    row({ ...base, Resi: "101", "Kecamatan Tujuan": "Cihideung", "Kode Pos": "46123" }, headers),
    row({ ...base, Resi: "102", "Kecamatan Tujuan": "Cihideung", "Kode Pos": "" }, headers),
    row({ ...base, Resi: "103", "Kecamatan Tujuan": "Tamansari", "Kode Pos": 46191 }, headers),
  ], { headers });
  assert.deepStrictEqual(["101", "102", "103"].map((r) => byResi(rows, r)["KODE POS PENERIMA"]), [46123, 46121, 46191]);
  assert.strictEqual(report.kodepos.fromTemplate, 2);
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
