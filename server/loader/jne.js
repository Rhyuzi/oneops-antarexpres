"use strict";

/**
 * Loader JNE — THE output of the loader (the only sheet of the downloaded
 * .xlsx, for file mode, API jobs and history re-downloads alike). Built from
 * the transformed rows (Rules 1–15 already applied: Berat per the weight
 * switch, KODEPOS, normalized phones, Nilai Barang, COD Y/N, cust ids,
 * one-line Alamat).
 *
 * Exactly the 34 columns, in order, of the Data Warrior sheets "Sukaraja" /
 * "Loader Rajapolah  Ciawi", with the operator's header names TGL DROP,
 * STATUS and NO RESI SICEPAT. Columns the operator fills later stay empty
 * (RESI JNE, STATUS, SS, KONTAK …) — their headers are always present.
 *
 * Sheet look (JNE_SHEET_STYLE, applied by excel.js), as in the Data Warrior
 * sheets: peach header, RESI JNE header soft blue (the column the operator
 * fills), "SS" as a narrow blank separator, panes frozen after RESI JNE
 * (row 1 + columns A–E stay visible while scrolling to NAMA PENGIRIM …), and
 * an AutoFilter on the header row.
 */

const { CUST_ID_HEADER } = require("./transform");

/** JUMLAH PACKING is always 1 per resi, whatever "Koli" the template has. */
const JUMLAH_PACKING = 1;

const JNE_HEADERS = [
  "TGL DROP", "STATUS", "CATEGORY", "NO RESI SICEPAT", "RESI JNE", "SS",
  "NAMA PENERIMA", "ALAMAT PENERIMA", "KOTA PENERIMA", "KODE POS PENERIMA",
  "KECAMATAN PENERIMA", "PROVINSI PENERIMA", "KONTAK PENERIMA", "NO HANDPHONE PENERIMA",
  "JUMLAH PACKING", "BERAT/KG", "DESKRIPSI BARANG", "HARGA BARANG",
  "KETERANGAN", "SERVICE", "ORDER ID / REFERENCE NUMBER", "PACKING KAYU", "ASURANSI",
  "COD", "HARGA COD", "NAMA PENGIRIM", "ALAMAT PENGIRIM", "KOTA PENGIRIM",
  "KECAMATAN PENGIRIM", "KODE POST PENGIRIM", "PROVINSI PENGIRIM", "KONTAK PENGIRIM",
  "NO HANDPHONE PENGIRIM", "CUSTOMER ID",
];
const JNE_SHEET = "LOADER JNE";
const JNE_HEADER_FILL = "FFF7C7AC"; // peach — header colour of the Data Warrior sheets
const RESI_JNE_HEADER_FILL = "FFBDD7EE"; // soft blue — the column the operator fills in
const JNE_SHEET_STYLE = {
  headerFill: JNE_HEADER_FILL,
  headerFills: { "RESI JNE": RESI_JNE_HEADER_FILL },
  spacerColumns: ["SS"], // narrow, unfilled, header text invisible (as in the samples)
  freezeAfter: "RESI JNE", // xSplit = 5, ySplit = 1
  autoFilter: true,
};
const LIST_CAP = 500;

/** Today (server-local calendar day) as a UTC-midnight Date — Excel shows it unshifted. */
function excelToday(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * @param {{headers: string[], rows: unknown[][], meta: Array<{rowNumber:number, geraiCode:string, geraiName:string}>}} result
 *        output of transformTemplate
 * @param {object} opts
 * @param {(meta: object, kotaTujuan: string) => {label: string, namaPengirim: string, source: string, reason: string|null, hub: string|null}} opts.lookupKotaPenerima
 * @param {string} opts.senderPhone   NO HANDPHONE PENGIRIM (digits)
 * @param {string} [opts.service="REG"]
 * @param {Date}   [opts.date]        TANGGAL (default: today)
 */
function buildJneSheet(result, { lookupKotaPenerima, senderPhone, service = "REG", date = excelToday() }) {
  const at = (name) => result.headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const col = {
    resi: at("Resi"), berat: at("Berat"), penerima: at("Penerima"),
    hp: at("No HP Penerima"), kota: at("Kota_Tujuan"), kodepos: at("KODEPOS"), kec: at("Kecamatan Tujuan"),
    alamat: at("Alamat Penerima"), barang: at("Nama Barang"), nilai: at("Nilai Barang"), cod: at("COD"),
    nilaiCod: at("Nilai COD"), cust: at(CUST_ID_HEADER),
  };
  const v = (row, i) => (i < 0 || row[i] === null || row[i] === undefined ? "" : row[i]);

  const report = { mapped: 0, fallback: 0, fallbackGroups: [] };
  const groups = new Map();

  const rows = result.rows.map((row, i) => {
    const meta = (result.meta && result.meta[i]) || { rowNumber: i + 2, geraiCode: "", geraiName: "" };
    const cod = String(v(row, col.cod)).trim();
    const kotaTujuan = String(v(row, col.kota));
    const kp = lookupKotaPenerima(meta, kotaTujuan);
    if (kp.source === "mapping") report.mapped++;
    else {
      report.fallback++;
      const key = `${kp.reason}|${kp.hub || ""}|${kotaTujuan}`;
      const g = groups.get(key) || { reason: kp.reason, hub: kp.hub, kotaTujuan, label: kp.label, count: 0, rows: [] };
      g.count++;
      if (g.rows.length < 50) g.rows.push(meta.rowNumber);
      groups.set(key, g);
    }
    const resi = v(row, col.resi);
    const values = {
      "TGL DROP": date,
      CATEGORY: cod === "Y" ? "COD" : cod === "N" ? "NON COD" : "",
      "NO RESI SICEPAT": resi,
      "RESI JNE": "", // header kept, filled by the operator after the JNE upload
      "NAMA PENERIMA": v(row, col.penerima),
      "ALAMAT PENERIMA": v(row, col.alamat),
      "KOTA PENERIMA": kp.label,
      "KODE POS PENERIMA": v(row, col.kodepos),
      "KECAMATAN PENERIMA": v(row, col.kec),
      "NO HANDPHONE PENERIMA": v(row, col.hp),
      "JUMLAH PACKING": JUMLAH_PACKING, // always 1 (template Koli is ignored)
      "BERAT/KG": v(row, col.berat),
      "DESKRIPSI BARANG": v(row, col.barang),
      "HARGA BARANG": v(row, col.nilai),
      SERVICE: service,
      "ORDER ID / REFERENCE NUMBER": resi,
      COD: cod,
      // Non-COD rows carry no COD amount (as in the Data Warrior sheets).
      "HARGA COD": cod === "N" ? 0 : v(row, col.nilaiCod),
      "NAMA PENGIRIM": kp.namaPengirim,
      "NO HANDPHONE PENGIRIM": senderPhone,
      "CUSTOMER ID": v(row, col.cust),
    };
    return JNE_HEADERS.map((h) => (h in values ? values[h] : ""));
  });

  report.fallbackGroups = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, LIST_CAP);
  return { headers: JNE_HEADERS, rows, report };
}

if (JNE_HEADERS.length !== 34) throw new Error("Loader JNE layout must have exactly 34 columns");

module.exports = { JNE_HEADERS, JNE_SHEET, JNE_HEADER_FILL, RESI_JNE_HEADER_FILL, JNE_SHEET_STYLE, buildJneSheet, excelToday };
