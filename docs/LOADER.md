# 3PL Loader (Automation Loader)

Turns the 3PL template export + the recipients' phone numbers into one
`.xlsx` with **one sheet, `LOADER JNE`**: the **Loader JNE layout**, i.e.
exactly the 34 columns, in order, of the Data Warrior sheets "Sukaraja" /
"Loader Rajapolah  Ciawi" (see [below](#result-3pl--data-warrior-jne-layout)).
The same file is produced by file mode, API jobs and history re-downloads.

The rules below first build intermediate rows (the "TAMPILAN FINAL" shape:
Resi, Berat, Berat Asli … CUST ID). That shape is **not exported**; it is
only the input of `server/loader/jne.js`.

UI: **Data Center → 3PL Loader** (`/ops/kodepos-loader`).

## Two modes (phone number source)

| Mode | Files | Phone numbers from |
|---|---|---|
| **Upload rechecked file** | 3PL template + rechecked Excel | The Excel exported by Number Rechecking (matched by Resi) |
| **Recheck automatically (API)** | 3PL template only | SiCepat `awbDetail`, one lookup per unique Resi, run as a server job |

API mode uses the **existing rechecker token system**: the Bearer Token,
X-Permission-Token and User ID entered in *Number Rechecking → Settings*
(browser `localStorage`). The browser sends them with the start/resume
request (`Authorization`, `x-permission-token`, body `sicepatUserId`). The
server keeps them **only in the job's memory** and wipes them when the
lookups stop. **They are never written to the DB, the audit trail or logs.**
There is no SiCepat account/credential table.

When the token expires mid-job (SiCepat 401/403) the job is **paused**:
the AWBs that already finished are kept. Update the token in Rechecker
Settings, then click *Resume with current token*. Only the remaining AWBs are
looked up again.

Flow: **pre-check** (server, no API call) → job (`running`) → `processing`
(building the file) → `done` (the file downloads automatically). The other
end states are `paused`, `cancelled`, `failed`, and `interrupted` (the server
restarted mid-job). Each user can have one active job at a time.

The pre-check reports:

- **Errors** (cannot start): missing required columns, no data rows.
- **Warnings** (start needs "Continue anyway"): duplicate Resi (looked up once),
  rows without Resi, kecamatan missing or ambiguous after the Kota_Tujuan →
  wilayah mapping, unknown COD values.
- **Notices** (information only, never blocking): empty cells, empty columns
  and blank rows (see [Empty data](#empty-data-warnings)), and the rows whose
  KOTA PENERIMA will fall back to Kota_Tujuan.

The client is `server/recheck/sicepatClient.js`, shared with
`/api/recheck/awb-detail`. The queue is `server/recheck/queue.js`:
concurrency 1–3, a delay between lookups, and retries on 429/5xx/network
errors with backoff (1 s, or 5 s for 429, doubling up to 30 s). A 404 is not
retried.

| Env | Default | |
|---|---|---|
| `LOADER_RECHECK_CONCURRENCY` | 2 | parallel lookups (clamped 1–3) |
| `LOADER_RECHECK_DELAY_MS` | 400 | pause per worker between lookups |
| `LOADER_RECHECK_MAX_RETRIES` | 3 | retries for 429/5xx/network |
| `LOADER_MAX_AWB_PER_JOB` | 3000 | larger templates must be split |
| `SICEPAT_BASE_URL` | `https://podapi.sicepat.com/` | point at a mock for tests |
| `LOADER_SENDER_PHONE` | `6282121221355` | Result 3PL `NO HANDPHONE PENGIRIM` (digits) |
| `LOADER_JNE_SERVICE` | `REG` | Result 3PL `SERVICE` |

## Permissions

| Key | Allows |
|---|---|
| `loader.view` | the page, **read-only** reference views (kodepos lookup, Kota_Tujuan → wilayah, gerai/HUB), pre-check, own job history |
| `loader.run` | process / download (file mode) |
| `loader.recheck` | API mode (start / resume / cancel jobs), together with `loader.run` |
| `loader.manage_settings` | see every user's jobs in the loader history |
| `master_data.view` / `.manage` / `.audit` | read / change / audit the reference data — see [MASTER-DATA.md](MASTER-DATA.md) |

**The 3PL Loader never changes reference data.** All create / edit / delete /
import happens in **Master Data** (migration 013 removed
`loader.manage_reference` and carried its grants over to `master_data.*`).
The loader reads the tables from the DB on every run, so a Master Data change
is used by the next run without a restart.

`super_admin` has all of them. Number Rechecking now also enforces its own
keys in the UI. `number_rechecking.run` gates the Start button and the
token settings page, and `number_rechecking.export` gates *Download Excel*.

## Kota_Tujuan → wilayah mapping

Table `loader_kota_wilayah`. When a kecamatan name exists in several
wilayah, a row's `Kota_Tujuan` decides which one is used. For example,
Purwadadi exists in TASIK and SUBANG, and *Kota Banjar* → TASIK. Lookup order:

1. The wilayah selected on the page.
2. The mapping.
3. Inference from the Kota_Tujuan text.

Migration 011 seeds Subang, Garut, Sukabumi, Tasikmalaya, Ciamis, Banjar
and Pangandaran (`source = seed`). Rows are added, changed, removed or
imported in **Master Data → Kota_Tujuan → Wilayah** (audited there). Kota
names are matched case-, space- and punctuation-insensitively.

## Result 3PL — Data Warrior JNE layout

Built by `server/loader/jne.js` from the transformed rows (all rules below
already applied). `JNE_HEADERS` holds exactly 34 columns; the module refuses
to load otherwise, and `tests/test-loader.js` pins the list and its order
against the sample's header rows. The sheet uses the same styling: Titillium Web 9, all
borders, number formats, and a bold header filled `F7C7AC` as in the Data
Warrior sheets.

| Column | Value |
|---|---|
| TGL DROP | processing date (Excel date, `dd/mm/yyyy`) |
| STATUS | empty (the operator's status/update column) |
| CATEGORY / COD | `COD` / `Y` or `NON COD` / `N` (COD normalization below) |
| NO RESI SICEPAT, ORDER ID / REFERENCE NUMBER | Resi (number, leading zeros kept by the format) |
| **RESI JNE** | **header kept, always empty**; the operator fills it after the JNE upload |
| NAMA / ALAMAT / KECAMATAN / KODE POS / NO HANDPHONE PENERIMA | Penerima, Alamat (on one line), Kecamatan Tujuan, KODEPOS, normalized phone |
| **KOTA PENERIMA** | the hub's label, see below (fallback: Kota_Tujuan, reported) |
| JUMLAH PACKING | Koli (≥ 1, default 1) |
| BERAT/KG | Berat per the weight switch (Berat Asli is used for the conversion, not exported) |
| DESKRIPSI BARANG, HARGA BARANG | Nama Barang, Nilai Barang (Rules 9/12/14) |
| HARGA COD | Nilai COD on COD rows, `0` on Non-COD rows |
| SERVICE | `REG` (`LOADER_JNE_SERVICE`) |
| NAMA PENGIRIM | the hub's sender name (default `SICEPAT <CITY>`) |
| **NO HANDPHONE PENGIRIM** | **`6282121221355`** (`LOADER_SENDER_PHONE`), numeric |
| CUSTOMER ID | the cust id (numeric) |
| SS, PROVINSI, KONTAK, KETERANGAN, PACKING KAYU, ASURANSI, sender address columns | empty (headers kept) |

Header names follow the Data Warrior sheets, except three that were renamed
at the operator's request: TANGGAL → **TGL DROP**, UPDATE → **STATUS**, and
RESI SICEPAT → **NO RESI SICEPAT**.

**Sheet look** (`JNE_SHEET_STYLE` in `jne.js`, applied by `excel.js`), as in
the "Loader Rajapolah  Ciawi" sheet:

- Headers are bold Titillium Web 9 with all borders, filled peach (`F7C7AC`).
- **RESI JNE** is filled **soft blue** (`BDD7EE`), because it is the column
  the operator fills.
- **SS** is a narrow (3) separator with no fill and invisible header text.
- **Frozen panes** after RESI JNE (`xSplit 5`, `ySplit 1`, top-left `F2`):
  row 1 and columns A–E stay visible while scrolling right to NAMA
  PENGIRIM and beyond.
- An **AutoFilter** covers `A1:AH<last row>`.

**COD normalization.** `COD`, `Y`, `YA`, `YES`, `TRUE`, `1` → `Y`.
`NON-COD`, `NON COD`, `NONCOD`, `N`, `NO`, `TIDAK`, `FALSE`, `0` → `N`. Case,
spaces, `-` and `_` are ignored. Any other value (e.g. `REG`) is never guessed:
it stays as is and is reported. Prices use the same category (Rules 11–14).

**Alamat Penerima.** `\r\n`, `\n` and `\r` each become one space, runs of
spaces collapse, and the value is trimmed. The count appears in the result.

### Gerai / HUB → KOTA PENERIMA (`DATAHUB.xlsx`, migration 012)

Table `loader_hub_kota`: one row per hub of `DATAHUB.xlsx` (Sheet1: DEST
CODE, CITY, HUB, ANALYTIC CODE, HUB TYPE) plus the labels `kota_penerima` and
`nama_pengirim`.

A template row finds its hub by **`Kode Gerai Terakhir`**, which is DATAHUB's
ANALYTIC CODE (e.g. `A1203010`). If that doesn't match, it tries
**`Nama Gerai Terakhir`**, which is the HUB name (matching ignores case,
spaces and punctuation).

- Hub has a label → `KOTA PENERIMA` = label (e.g. *Sukabumi Sagaranten LM* →
  `Kab. Sukabumi Sgr`, *Sukabumi Jampang Kulon LM* → `Kab. Sukabumi Jp`).
- Otherwise → **fallback `Kota_Tujuan`**, reported per hub with the Excel rows
  and one of these reasons:
  - `no_label`: the hub is known but has no label yet.
  - `unknown_hub`: the gerai is not in DATAHUB.
  - `no_gerai`: the template has no gerai columns, e.g. an already-trimmed
    loader file.

Migration 012 seeds the 53 DATAHUB hubs and the two labels above. Every
other label is set in **Master Data → Gerai / HUB → KOTA PENERIMA** (filter
"Only hubs without a label"; requires `master_data.manage`; audited). Leave
a label empty to use Kota_Tujuan. Re-import DATAHUB there or with
`npm run loader:hubs -- DATAHUB.xlsx`. This refreshes the master columns and
**never overwrites labels**. The loader page shows the hubs read-only.

## Empty data warnings

Checked on every template data row; these warnings never block and never
change the output:

- **Empty cells.** Listed with the **Excel row number**, Resi and the column
  names, plus a count per column. Empty means null, undefined, or blank
  text. Checked columns: Resi, Berat, Berat Asli, Penerima, Kota_Tujuan,
  Kecamatan Tujuan, Alamat Penerima, Nama Barang, COD, Biaya, and Nilai COD
  (COD rows only). No HP Penerima and Nilai Barang are covered by their own
  rules.
- **Empty columns.** Output columns that are empty on every row.
- **Blank rows.** Fully empty rows between data rows. They are skipped and
  listed by row number.

They are in `report.empty` (result) and `precheck.notices.empty` (pre-check),
and the UI shows them in the warnings list.

## Job history

Table `loader_jobs`: mode, status, file name, wilayah, cust ids, counts
(rows / AWB total / processed / success / failed), error code and message,
and a counts-only summary. It also stores the download id and its expiry.
The summary also holds empty-cell counts and the KOTA PENERIMA fallback
hubs. **No phone numbers, no tokens, no row data.** The generated file itself
stays in server memory for 15 minutes only.

## Setup

```bash
mysql -u <user> -p <db> < database/migrations/010_kebutuhan_loader.sql
mysql -u <user> -p <db> < database/migrations/011_loader_jobs_kota_wilayah.sql
mysql -u <user> -p <db> < database/migrations/012_loader_hub_kota.sql   # DATAHUB hubs + 2 labels
mysql -u <user> -p <db> < database/migrations/013_master_data.sql      # Master Data permissions
# reference data — any ONE of:
npm run loader:import -- "KEBUTUHAN LOADER.xlsx"                # upsert into DB
mysql -u <user> -p <db> < database/seeds/003_kebutuhan_loader.sql # pre-generated
# …or Master Data → Kodepos Reference → Import Excel.
```

Re-running any of them is safe (`UNIQUE (wilayah, kecamatan, kodepos)`; the
011 seed uses `INSERT IGNORE`). To regenerate the seed after the master changes:
`npm run loader:import -- "KEBUTUHAN LOADER.xlsx" --sql database/seeds/003_kebutuhan_loader.sql`.
Rollback: `013_rollback.sql`, `012_rollback.sql`, `011_rollback.sql`,
then `010_rollback.sql`.

- Without 011, file mode still works: history is skipped with a warning, and
  the mapping is treated as empty.
- Without 012, every KOTA PENERIMA uses the Kota_Tujuan fallback (reported).

On XAMPP: `C:\xampp\mysql\bin\mysql.exe -u root <db> < database\migrations\012_loader_hub_kota.sql`.

## Inputs

| Input | Notes |
|---|---|
| 3PL template (.xlsx/.xls) | First sheet whose header row has Resi, Berat, Berat Asli (+ the columns below) |
| Rechecked Excel (file mode) | Any sheet with **Resi** and **No HP Penerima** |
| `cust_id_non_cod` / `cust_id_cod` | Both required, digits only (max 15 — written as Excel numbers), must differ (Rule 17) |
| Wilayah (optional) | Only breaks ties when a kecamatan exists in several wilayah; "Automatic" uses the mapping / `Kota_Tujuan` |

Required template columns: Resi, Berat, Berat Asli, No HP Penerima,
Kecamatan Tujuan, Nilai Barang, COD, Biaya, Nilai COD, Status Terakhir.
(`CUST ID` is the **output** name of Status Terakhir — the input must still
have `Status Terakhir`.)

## Rules (in order) — `server/loader/transform.js`

1. Remove the 25 unused columns (case-insensitive, trimmed).
2. **Berat Asli moves directly right of Berat**; Asal_kecamatan is dropped.
3. Sort rows by the **final** Berat ascending (stable) — the converted value
   when the switch is on, the template value when it is off. (Runs after
   Rule 4, so the order matches the Berat written to the file.)
4. **Switchable** — *Convert Berat from Berat Asli* (body
   `convertWeightFromActual`, default **on**; the page remembers the choice
   per browser). On: if Berat ≥ 2 and Berat Asli ≤ Berat, Berat = Berat Asli
   rounded to kilos — decimal ≥ 0.3 up, < 0.3 down, minimum 1
   (0.75→1, 9.1→9, 2.3→3); **never changed when Berat Asli > Berat**.
   Off: Berat stays exactly as in the template (a non-numeric Berat is
   reported). The report has `weight.conversion`; the audit and the job
   history record `convert_weight` / `weightConversion`.
5. Berat Asli is **kept** (right of Berat, original value) for manual checking.
6. Insert **KODEPOS left of Kecamatan Tujuan**, from `kebutuhan_loader`
   (name match ignores case/spaces/punctuation/"Kec."). Same name with several
   kodepos → narrowed by wilayah (see the mapping above); still ambiguous →
   left empty and reported.
7. No HP Penerima ← rechecked file (file mode) or SiCepat (API mode), matched
   by Resi (leading zeros ignored).
8. Normalize to `628…` with the **shared** rule `server/recheck/phone.js`
   (its TS twin `src/lib/phone.ts` is used by the Number Rechecking queue, and
   `tests/fixtures/phone-cases.json` keeps both in sync): strip non-digits,
   `0062…`/`620…`/`0…`/`8…` fixed; valid = 628 + 7–11 digits; other values are
   kept as digits and reported.
9. Nilai Barang 0/empty → 500000.
10. Status Terakhir ← cust id (COD → `cust_id_cod`, Non-COD → `cust_id_non_cod`);
    the column is renamed **`CUST ID`** and holds numbers (numeric cells, format `0`).
    Rows with an unknown COD value keep their original text there (and are reported).
11. Non-COD → `N`. 12. Non-COD Nilai Barang = Biaya × Berat + Nilai Barang.
13. COD → `Y`. 14. COD Nilai Barang = Nilai COD − Berat × 2800.
    (Berat = the value written to the file: converted when the switch is on,
    the template value when off.)
15. Remove Koli and Biaya.
16. Output via ExcelJS: Titillium Web 9 (header bold, centered), thin borders
    on every cell, numbers stored as numbers (no formulas); Resi as number
    with format `000000000000`, phone/KODEPOS as numbers with format `0`.

Unknown COD values are not converted (row reported). Every exception is listed
in the result summary — nothing is guessed silently. In API mode, Resi without
a valid number from SiCepat are listed with the reason: not found, no valid
number, or SiCepat error.

## API

All paths are under `/api/loader`. Reference endpoints here are **GET only**;
changes go through `/api/master-data` (MASTER-DATA.md). `{name, data}` = file with base64 data
(≤ 10 MB each).

| Method | Path | Permission / notes |
|---|---|---|
| POST | `/process` | `loader.run` — `{ template, rechecked, custIdCod, custIdNonCod, wilayah?, convertWeightFromActual? }` → `{ report, download, jobId }` |
| GET | `/download/:id` | `loader.run` — `.xlsx` attachment; owner only, 15 min |
| POST | `/precheck` | `loader.run` — `{ template, wilayah? }` → `{ precheck }` incl. `notices` (no API call) |
| POST | `/jobs` | `loader.run` + `loader.recheck`; token headers required. Body: `{ template, custIdCod, custIdNonCod, wilayah?, convertWeightFromActual?, sicepatUserId?, acknowledgeWarnings? }`. Responses: `202 { job }`; `400 PRECHECK_FAILED`; `409 PRECHECK_WARNINGS` (resend with `acknowledgeWarnings: true`); `409 JOB_ALREADY_RUNNING`; `400 SICEPAT_CREDENTIALS_MISSING` |
| GET | `/jobs` | `loader.view` — own jobs; `?scope=all` with `loader.manage_settings` |
| GET | `/jobs/:id` | `loader.view` — progress, report and download when done (owner, or `manage_settings`) |
| POST | `/jobs/:id/resume` | `loader.recheck` — paused jobs only; uses the token headers of this request |
| POST | `/jobs/:id/cancel` | `loader.recheck` — running jobs |
| GET | `/settings/kota-wilayah` | `loader.view` — `{ mappings, wilayah }` |
| GET | `/settings/hubs` | `loader.view` — `{ hubs }` (503 without migration 012) |
| GET | `/reference/summary`, `/reference?wilayah=&search=` | `loader.view` |

Audit actions:

- File mode: `loader.processed`, `loader.process_failed`.
- Jobs: `loader.job_started`, `loader.job_completed`, `loader.job_paused`,
  `loader.job_resumed`, `loader.job_cancelled`, `loader.job_failed`.
- Reference data changes: `master_data.create|update|delete|import` (see
  MASTER-DATA.md). Older rows may still show the former
  `loader.kota_mapping_*`, `loader.hub_mapping_updated`, `loader.hubs_imported`
  and `loader.reference_imported` actions.

Audit entries hold counts only. No customer data and no tokens.

## Tests

- `npm test` → `tests/test-loader.js` and `tests/test-phone.js` (no DB;
  `test-loader.js` uses the `./tmp` samples when present):
  - `test-loader.js`: transform, weight switch, Result 3PL layout, COD
    normalization, address, sender phone, KOTA PENERIMA mapping + fallback,
    empty-data warnings, pre-check, the queue with a fake client, and
    DATAHUB ↔ migration 012.
  - `test-phone.js`: the server and TS phone rules agree.
- `node tests/check-loader-export.js [--api http://localhost:3001]` prints row 1
  of the exported `.xlsx`. Without `--api` it runs the current code; with
  `--api` it uses a running server's Download endpoint. Exit code 1 means the
  output is not the 34-column Loader JNE layout. With `--api`, that usually
  means the server runs old code: `npm run dev` does not reload the backend,
  so restart it after pulling changes.
- `node tests/live-loader.test.js` (running server + DB: file mode, Result 3PL,
  hub settings API)
- `node tests/live-loader-api.test.js` (API mode against a mock SiCepat on
  :39190 — start the backend with `SICEPAT_BASE_URL=http://localhost:39190/
  LOADER_RECHECK_DELAY_MS=0`)
- `node tests/e2e-loader.mjs` (Node ≥ 22, Chrome, built app; the API-mode case
  uses a mock on :39191 → backend `SICEPAT_BASE_URL=http://localhost:39191/`)
