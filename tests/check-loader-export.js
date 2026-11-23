#!/usr/bin/env node
"use strict";

/**
 * Prints the header row (row 1) of the Loader .xlsx EXACTLY as produced —
 * proof that the export is the 34-column Data Warrior "Loader JNE" layout.
 *
 *   node tests/check-loader-export.js                       # current code, in-process (DB for lookups)
 *   node tests/check-loader-export.js --api http://localhost:3001
 *        # what a RUNNING server returns: login → POST /api/loader/process →
 *        # GET /api/loader/download/:id (the same endpoint as the Download button)
 *
 * Template: ./tmp/LOADER BANJAR 20 NOV.xlsx (or --template <file>); it is also
 * used as the "rechecked" file (it has Resi + No HP Penerima).
 * --api logs in as LOADER_CHECK_USER / LOADER_CHECK_PASSWORD (default: the
 * local seed user superadmin / admin123). Exit code 1 when the header is not
 * the 34-column layout. Node 14 compatible.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const ExcelJS = require("exceljs");

const LOADER_JNE_34 = [
  "TGL DROP", "STATUS", "CATEGORY", "NO RESI SICEPAT", "RESI JNE", "SS", "NAMA PENERIMA",
  "ALAMAT PENERIMA", "KOTA PENERIMA", "KODE POS PENERIMA", "KECAMATAN PENERIMA",
  "PROVINSI PENERIMA", "KONTAK PENERIMA", "NO HANDPHONE PENERIMA", "JUMLAH PACKING",
  "BERAT/KG", "DESKRIPSI BARANG", "HARGA BARANG", "KETERANGAN", "SERVICE",
  "ORDER ID / REFERENCE NUMBER", "PACKING KAYU", "ASURANSI", "COD", "HARGA COD",
  "NAMA PENGIRIM", "ALAMAT PENGIRIM", "KOTA PENGIRIM", "KECAMATAN PENGIRIM",
  "KODE POST PENGIRIM", "PROVINSI PENGIRIM", "KONTAK PENGIRIM", "NO HANDPHONE PENGIRIM",
  "CUSTOMER ID",
];

const args = process.argv.slice(2);
const opt = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null);
const TEMPLATE = opt("--template") || path.join(__dirname, "..", "tmp", "LOADER BANJAR 20 NOV.xlsx");
const API = opt("--api");
const IDS = { custIdCod: "82220300", custIdNonCod: "82220303" };

function httpRequest(base, method, p, { cookie, body } = {}) {
  const url = new URL(p, base);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname, method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, buf, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function viaApi(base) {
  const file = { name: path.basename(TEMPLATE), data: fs.readFileSync(TEMPLATE).toString("base64") };
  const login = await httpRequest(base, "POST", "/api/auth/login", {
    body: { username: process.env.LOADER_CHECK_USER || "superadmin", password: process.env.LOADER_CHECK_PASSWORD || "admin123" },
  });
  if (login.status !== 200) throw new Error(`login failed (HTTP ${login.status})`);
  const cookie = (login.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  const proc = await httpRequest(base, "POST", "/api/loader/process", { cookie, body: { template: file, rechecked: file, ...IDS } });
  if (proc.status !== 200) throw new Error(`process failed (HTTP ${proc.status}): ${proc.json && proc.json.message}`);
  const dl = await httpRequest(base, "GET", `/api/loader/download/${proc.json.download.id}`, { cookie });
  if (dl.status !== 200) throw new Error(`download failed (HTTP ${dl.status})`);
  return { buffer: dl.buf, filename: proc.json.download.filename, source: `${base} (GET /api/loader/download/:id)` };
}

async function inProcess() {
  const { processLoader } = require("../server/loader/service");
  const buf = fs.readFileSync(TEMPLATE);
  const out = await processLoader({
    templateBuffer: buf, templateName: path.basename(TEMPLATE),
    recheckedBuffer: buf, recheckedName: path.basename(TEMPLATE), ...IDS,
  });
  const { pool } = require("../server/db");
  if (pool) await pool.end();
  return { buffer: out.buffer, filename: out.filename, source: "current code (server/loader/service.js → processLoader)" };
}

async function main() {
  if (!fs.existsSync(TEMPLATE)) throw new Error(`template not found: ${TEMPLATE}`);
  const { buffer, filename, source } = API ? await viaApi(API) : await inProcess();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  console.log(`source   : ${source}`);
  console.log(`template : ${path.basename(TEMPLATE)}`);
  console.log(`file     : ${filename}`);
  console.log(`sheets   : ${JSON.stringify(wb.worksheets.map((w) => w.name))}`);
  const ws = wb.worksheets[0];
  const headers = ws.getRow(1).values.slice(1);
  console.log(`rows     : ${ws.rowCount - 1} data rows, ${headers.length} columns`);
  console.log("row 1    :");
  headers.forEach((h, i) => console.log(`  ${String(i + 1).padStart(2)}. ${h}`));
  const second = ws.getRow(2);
  const at = (h) => (headers.indexOf(h) < 0 ? { value: "(column missing)" } : second.getCell(headers.indexOf(h) + 1));
  console.log("row 2    : " + JSON.stringify({
    "RESI JNE": at("RESI JNE").value,
    COD: at("COD").value,
    "NO HANDPHONE PENGIRIM": at("NO HANDPHONE PENGIRIM").value,
    "CUSTOMER ID": at("CUSTOMER ID").value,
    "CUSTOMER ID type": typeof at("CUSTOMER ID").value,
    font: `${second.getCell(1).font.name} ${second.getCell(1).font.size}`,
  }));
  const fillOf = (h) => {
    const c = ws.getRow(1).getCell(headers.indexOf(h) + 1);
    return c.fill && c.fill.fgColor ? c.fill.fgColor.argb : "(none)";
  };
  const v = (ws.views || [])[0] || {};
  console.log(`autoFilter: ${JSON.stringify(ws.autoFilter)}`);
  console.log(`views    : ${JSON.stringify({ state: v.state, xSplit: v.xSplit, ySplit: v.ySplit, topLeftCell: v.topLeftCell })}`);
  console.log(`fills    : ${JSON.stringify({ "RESI JNE": fillOf("RESI JNE"), "TGL DROP": fillOf("TGL DROP"), "NAMA PENERIMA": fillOf("NAMA PENERIMA"), SS: fillOf("SS") })}`);
  const ok = wb.worksheets.length === 1 && JSON.stringify(headers) === JSON.stringify(LOADER_JNE_34) &&
    ws.autoFilter === `A1:AH${ws.rowCount}` && v.state === "frozen" && v.xSplit === 5 && v.ySplit === 1 &&
    fillOf("RESI JNE") === "FFBDD7EE";
  console.log(ok
    ? "RESULT   : OK — 34 Loader JNE columns in order, one sheet, AutoFilter, frozen after RESI JNE, RESI JNE header blue."
    : "RESULT   : NOT the Loader JNE layout — if this is --api, that server runs old code: restart it.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("check failed:", err.message);
  process.exit(2);
});
