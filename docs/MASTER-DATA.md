# Master Data

Maintenance of the reference data used by the **3PL Loader**. The loader
itself is read-only for this data: it looks it up on every run, straight from
the DB with no cache. A change here is therefore used by the next loader run
without a server restart.

UI: sidebar group **MASTER DATA** (`/ops/master-data/*`):

| Page | Table | Audit `entity_type` |
|---|---|---|
| Gerai / HUB → KOTA PENERIMA | `loader_hub_kota` (DATAHUB.xlsx, migration 012) | `gerai_kota_mapping` |
| Kota_Tujuan → Wilayah | `loader_kota_wilayah` (migration 011) | `kota_wilayah_mapping` |
| Kodepos Reference | `kebutuhan_loader` (migration 010) | `kodepos_reference` |
| Wilayah | `master_wilayah` (migration 014) | `master_wilayah` |
| Cust ID per wilayah | `master_cust_id` — FK `wilayah_id` → `master_wilayah.id` | `master_cust_id` |
| Kota per wilayah | `master_wilayah_kota` — FK `wilayah_id` → `master_wilayah.id` | `master_wilayah_kota` |
| Master Data Audit Trail | `storage_audit_logs` (actions `master_data.*`) | — |

Each reference page offers search, filters (wilayah, or "only hubs without a
label"), pagination (25 per page), add, edit, delete (with confirmation),
and Excel import. Every text is translated (EN/ID).

## Permissions

| Key | Allows |
|---|---|
| `master_data.view` | open Master Data, browse and search the three tables |
| `master_data.manage` | create / edit / delete / import |
| `master_data.audit` | the Master Data audit trail (before / after values) |

Reading the references inside the 3PL Loader only needs `loader.view`. The
loader shows a *Manage in Master Data* link only to users with
`master_data.manage`. The server enforces every key; the UI only hides what
the user cannot use. `super_admin` has everything.

Migration **013** adds the keys and removes `loader.manage_reference`. Every
role that had `loader.manage_reference` or `loader.manage_settings` receives
all three `master_data.*` keys, so nobody loses access.
`loader.manage_settings` now only means "see every user's loader jobs".

```bash
mysql -u <user> -p <db> < database/migrations/013_master_data.sql
# XAMPP: C:\xampp\mysql\bin\mysql.exe -u root <db> < database\migrations\013_master_data.sql
# rollback: database/migrations/013_rollback.sql
```

Idempotent; no new tables (the audit trail reuses `storage_audit_logs`).
Requires 010–012.

## Validation

| Entity | Rules |
|---|---|
| HUB | name ≥ 3 chars (unique, matched ignoring case/spaces/punctuation); analytic code letters/digits ≤ 30 (stored uppercase); KOTA PENERIMA / NAMA PENGIRIM optional — empty = loader fallback (Kota_Tujuan) / default (`SICEPAT <CITY>`) |
| Kota_Tujuan → wilayah | kota ≥ 3 chars (unique, normalized); wilayah must exist in the kodepos reference |
| Kodepos | wilayah required (stored uppercase), kecamatan ≥ 2 chars, kodepos exactly 5 digits; (wilayah, kecamatan, kodepos) unique |
| Wilayah | name ≥ 3 chars (unique, normalized); kodepos code optional but must exist in the kodepos reference (unique); NAMA PENGIRIM base optional (empty = `SICEPAT <WILAYAH>`) |
| Cust ID per wilayah | wilayah required (must exist — FK); one row per wilayah (409 otherwise); N and Y digits only (≤ 15, not 0) and different (also a DB `CHECK`) |
| Kota per wilayah | wilayah required (FK); kota ≥ 2 chars, unique per wilayah; aliases = comma-separated search names (e.g. `sukareja`), de-duplicated; KOTA PENGIRIM optional (≤ 100, empty = wilayah rule) |

A wilayah that still has a Cust ID row or kota cannot be deleted (FK `ON DELETE RESTRICT` → **409** "This wilayah still has cust IDs or kota"). Delete the children first.

A duplicate key returns **409**, invalid input **400** (message translated in
the UI), and an unknown record **404**.

## Import (Excel, ≤ 10 MB)

Wilayah, Cust ID and Kota per wilayah have no Excel import (few rows; edited in the forms).

| Entity | File |
|---|---|
| HUB | `DATAHUB.xlsx`: any sheet with `HUB` + `ANALYTIC CODE` (DEST CODE, CITY, HUB TYPE optional). Upsert by hub; labels are never overwritten. |
| Kota_Tujuan → wilayah | Any sheet with `Kota_Tujuan` (or `Kota`) + `Wilayah`. Rows with an unknown wilayah are skipped and reported with their Excel row number. |
| Kodepos | The master workbook (`KEBUTUHAN LOADER.xlsx`): every sheet with a `Kecamatan \| Kode Pos` header; the sheet name becomes the wilayah. |

## Audit trail

Every mutation writes one row to `storage_audit_logs`:

| Column | Value |
|---|---|
| `action` | `master_data.create` / `.update` / `.delete` / `.import`, shown as CREATE / UPDATE / DELETE / IMPORT |
| `entity_type` | `gerai_kota_mapping` / `kota_wilayah_mapping` / `kodepos_reference` / `master_wilayah` / `master_cust_id` / `master_wilayah_kota` |
| `entity_id` | the record id (none for an import) |
| `metadata` | v2 envelope: `before` / `after` JSON snapshots, the actor (username, name, roles), and `details` with `entity`, `record_key` and, for imports, `file` / `sheet` |
| `user_id`, `created_at` | the user and the time |

Snapshots hold reference columns only (hub, kota, wilayah, kecamatan,
kodepos, labels), never recipient phone numbers. The rows also appear in the
global Audit Trail under module **Master Data**.

The Master Data Audit Trail page (`master_data.audit`) filters by data
(entity), action, date range and free text (record or user). Each row expands
to show field-by-field **before → after**.

## API — `/api/master-data` (JSON; files as base64)

| Method | Path | Permission |
|---|---|---|
| GET | `/meta` | view — `{ wilayah }` (choices for the forms) |
| GET | `/audit?entityType&action&from&to&search&page&pageSize` | audit |
| GET | `/:entity?search&page&pageSize` (+ `wilayah`, or `missingLabel=1` for hubs) | view → `{ rows, total, page, pageSize }` |
| POST | `/:entity` | manage → `201 { id, row }` |
| PUT | `/:entity/:id` | manage → `{ id, row }` |
| DELETE | `/:entity/:id` | manage |
| POST | `/:entity/import` — `{ file: { name, data } }` | manage → `{ rows, inserted, updated, skipped[], sheet }` |

`:entity` is one of `hubs`, `kota-wilayah`, `kodepos`, `wilayah`, `cust-id` or `wilayah-kota` (the last two filter by `?wilayahId=`; `/meta` also returns `masterWilayah: [{ id, name }]`). Code:
`server/routes/masterData.js`, `server/masterData/{service,audit}.js`,
`src/views/MasterDataView.vue`, `src/components/masterData/*`,
`src/lib/masterData.ts`.

## Tests

- `npm test` → `tests/test-master-data.js` (no DB). It covers validators, the
  permission split (registry + migration 013 + the loader router has no
  reference mutations), audit mapping and entry shape, and that snapshots
  hold no phone numbers.
- `node tests/live-master-data.test.js` (running server + DB). It covers:
  - read-only loader (old endpoints 404) and the permission matrix
    (loader-only / viewer / manager / super admin);
  - the grant carry-over SQL of migration 013;
  - CRUD + validation + pagination for all three entities, and the Excel
    imports;
  - audit before/after, filters and date validation;
  - **the effect on the 3PL Loader**: an edited hub label and kodepos show up
    in the next Loader JNE file.

  Every change is restored afterwards.
- `node tests/e2e-master-data.mjs` (Node ≥ 22, Chrome, built app). It covers
  the sidebar, the read-only loader cards and links, create / edit / delete
  through the UI, the audit tab with before → after, and the Indonesian UI.

## Wilayah master (migration 014)

`master_wilayah` ← `master_cust_id` / `master_wilayah_kota` (FK `wilayah_id`).
The 3PL Loader form picks a **wilayah** and one of **its kota**; the server
resolves everything else from these tables on every run:

| Output | Rule |
|---|---|
| Cust ID Non-COD (N) / COD (Y) | `master_cust_id` of the wilayah — read-only in the form, never taken from the request |
| `CUSTOMER ID` (JNE) | Y → COD id, N → Non-COD id (numeric) |
| `KOTA PENGIRIM` (JNE) | the kota's `kota_pengirim` when set (migration 015); otherwise empty for Tasikmalaya (name or code `TASIK`, case-insensitive), else the wilayah name |
| `NAMA PENGIRIM` (JNE) | `<nama_pengirim_base> <kota>`, spaces collapsed (e.g. `SICEPAT TASIKMALAYA Sukaraja`) |
| kodepos lookup scope | `kodepos_wilayah` (e.g. `TASIK`) |

Seed: Subang (`SUBANG`, N 82220303 / Y 82220300: Kalijati, Kartini, Subang
Barat), Tasikmalaya (`TASIK`, N 82191603 / Y 82191600: Sukaraja — alias
*sukareja* —, Ciamis, Banjar, Singaparna, Pangandaran, Mangkubumi), Sukabumi
(`SUKABUMI`, N 82221700 / Y 82221701: Nyalindung, Sagaranten, Jampang,
Parungkuda, Pelabuhan), Garut (`GARUT`, N 81706800 / Y 81706801: Kota Garut).

```bash
mysql -u <user> -p <db> < database/migrations/014_master_wilayah.sql
# XAMPP: C:\xampp\mysql\bin\mysql.exe -u root <db> < database\migrations\014_master_wilayah.sql
# rollback: database/migrations/014_rollback.sql
```

Idempotent (re-running never overwrites values edited in the app); requires
001 and 010.

**Migration 015** adds `master_wilayah_kota.kota_pengirim` and fills it for
Tasikmalaya only where empty: Mangkubumi, Singaparna, Sukaraja (alias
*sukareja*) → `Tasikmalaya`; Ciamis → `Ciamis`. Banjar, Pangandaran and any
new kota stay empty → KOTA PENGIRIM empty. Edit the value per kota in
**Master Data → Kota per wilayah** (audited). NAMA PENGIRIM is unaffected (always
`<base> <kota name>`).

```bash
mysql -u <user> -p <db> < database/migrations/015_kota_pengirim.sql
# rollback: database/migrations/015_rollback.sql
``` Tests: `tests/test-wilayah.js` (in `npm test`),
`tests/live-wilayah.test.js` (server + DB), `tests/e2e-loader.mjs` and
`tests/e2e-master-data.mjs` (browser).
