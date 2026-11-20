# Kodepos Loader (Automation Loader)

Turns the 3PL template export + the recipients' phone numbers into the loader
file: the "TAMPILAN FINAL" layout of `KEBUTUHAN LOADER.xlsx`, plus `Berat Asli`
right of `Berat` (kept for manual checking), and the last column named
`CUST ID` (numeric) instead of `Status Terakhir`.

UI: **Data Center → Kodepos Loader** (`/ops/kodepos-loader`).

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

## Permissions

| Key | Allows |
|---|---|
| `loader.view` | the page, reference, pre-check, own job history, mapping list |
| `loader.run` | process / download (file mode) |
| `loader.recheck` | API mode (start / resume / cancel jobs), together with `loader.run` |
| `loader.manage_reference` | import the kodepos master |
| `loader.manage_settings` | edit the Kota_Tujuan → wilayah mapping; see every user's jobs |

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
and Pangandaran (`source = seed`). Users with `loader.manage_settings` can add,
change or remove rows on the page. Kota names are matched case-, space- and
punctuation-insensitively. Each change is audited:
`loader.kota_mapping_created`, `_updated` or `_deleted`.

## Job history

Table `loader_jobs`: mode, status, file name, wilayah, cust ids, counts
(rows / AWB total / processed / success / failed), error code and message,
and a counts-only summary. It also stores the download id and its expiry.
**No phone numbers, no tokens, no row data.** The generated file itself
stays in server memory for 15 minutes only.

## Setup

```bash
mysql -u <user> -p <db> < database/migrations/010_kebutuhan_loader.sql
mysql -u <user> -p <db> < database/migrations/011_loader_jobs_kota_wilayah.sql
# reference data — any ONE of:
npm run loader:import -- "KEBUTUHAN LOADER.xlsx"                # upsert into DB
mysql -u <user> -p <db> < database/seeds/003_kebutuhan_loader.sql # pre-generated
# …or "Import master Excel" on the page.
```

Re-running any of them is safe (`UNIQUE (wilayah, kecamatan, kodepos)`; the
011 seed uses `INSERT IGNORE`). To regenerate the seed after the master changes:
`npm run loader:import -- "KEBUTUHAN LOADER.xlsx" --sql database/seeds/003_kebutuhan_loader.sql`.
Rollback: `011_rollback.sql`, then `010_rollback.sql`. Without 011 the file
mode still works: history is skipped with a warning, and the mapping is
treated as empty.

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
3. Sort rows by Berat ascending (stable).
4. If Berat ≥ 2 and Berat Asli ≤ Berat: Berat = Berat Asli rounded to kilos —
   decimal ≥ 0.3 up, < 0.3 down, minimum 1 (0.75→1, 9.1→9, 2.3→3).
   **Never changed when Berat Asli > Berat.**
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
    (Berat = the normalized value from Rule 4.)
15. Remove Koli and Biaya.
16. Output via ExcelJS: Titillium Web 9 (header bold, centered), thin borders
    on every cell, numbers stored as numbers (no formulas); Resi as number
    with format `000000000000`, phone/KODEPOS as numbers with format `0`.

Unknown COD values are not converted (row reported). Every exception is listed
in the result summary — nothing is guessed silently. In API mode, Resi without
a valid number from SiCepat are listed with the reason: not found, no valid
number, or SiCepat error.

## API

All paths are under `/api/loader`. `{name, data}` = file with base64 data
(≤ 10 MB each).

| Method | Path | Permission / notes |
|---|---|---|
| POST | `/process` | `loader.run` — `{ template, rechecked, custIdCod, custIdNonCod, wilayah? }` → `{ report, download, jobId }` |
| GET | `/download/:id` | `loader.run` — `.xlsx` attachment; owner only, 15 min |
| POST | `/precheck` | `loader.view` — `{ template, wilayah? }` → `{ precheck }` (no API call) |
| POST | `/jobs` | `loader.run` + `loader.recheck`; token headers required. Body: `{ template, custIdCod, custIdNonCod, wilayah?, sicepatUserId?, acknowledgeWarnings? }`. Responses: `202 { job }`; `400 PRECHECK_FAILED`; `409 PRECHECK_WARNINGS` (resend with `acknowledgeWarnings: true`); `409 JOB_ALREADY_RUNNING`; `400 SICEPAT_CREDENTIALS_MISSING` |
| GET | `/jobs` | `loader.view` — own jobs; `?scope=all` with `loader.manage_settings` |
| GET | `/jobs/:id` | `loader.view` — progress, report and download when done (owner, or `manage_settings`) |
| POST | `/jobs/:id/resume` | `loader.recheck` — paused jobs only; uses the token headers of this request |
| POST | `/jobs/:id/cancel` | `loader.recheck` — running jobs |
| GET | `/settings/kota-wilayah` | `loader.view` — `{ mappings, wilayah }` |
| POST | `/settings/kota-wilayah` | `loader.manage_settings` — `{ kota, wilayah }` (upsert by normalized kota) |
| DELETE | `/settings/kota-wilayah/:id` | `loader.manage_settings` |
| GET | `/reference/summary`, `/reference?wilayah=&search=` | `loader.view` |
| POST | `/reference/import` | `loader.manage_reference` — `{ file }` |

Audit actions:

- File mode: `loader.processed`, `loader.process_failed`.
- Jobs: `loader.job_started`, `loader.job_completed`, `loader.job_paused`,
  `loader.job_resumed`, `loader.job_cancelled`, `loader.job_failed`.
- Settings and reference: `loader.kota_mapping_*`, `loader.reference_imported`.

Audit entries hold counts only. No customer data and no tokens.

## Tests

- `npm test` → `tests/test-loader.js` (transform, mapping, pre-check,
  queue with a fake client; no DB; uses `./tmp` samples when present) and
  `tests/test-phone.js` (server/TS phone rules agree)
- `node tests/live-loader.test.js` (running server + DB, file mode)
- `node tests/live-loader-api.test.js` (API mode against a mock SiCepat on
  :39190 — start the backend with `SICEPAT_BASE_URL=http://localhost:39190/
  LOADER_RECHECK_DELAY_MS=0`)
- `node tests/e2e-loader.mjs` (Node ≥ 22, Chrome, built app; the API-mode case
  uses a mock on :39191 → backend `SICEPAT_BASE_URL=http://localhost:39191/`)
