-- ============================================================================
-- 012_loader_hub_kota.sql — gerai / HUB master for the Result 3PL (Data
-- Warrior JNE layout). Requires 001 (users).
--
-- Creates:
--   loader_hub_kota : one row per hub of DATAHUB.xlsx (DEST CODE, CITY, HUB,
--                     ANALYTIC CODE, HUB TYPE) + the labels the JNE sheet needs:
--                       kota_penerima — KOTA PENERIMA for rows whose 3PL
--                                       template "Kode Gerai Terakhir" /
--                                       "Nama Gerai Terakhir" is this hub
--                                       (NULL → the row falls back to its
--                                       Kota_Tujuan and is reported)
--                       nama_pengirim — NAMA PENGIRIM (default SICEPAT <CITY>)
--                     Editable in the app (3PL Loader → settings, permission
--                     loader.manage_settings, audited); re-importing DATAHUB
--                     never overwrites edited labels.
--
-- Seed: the 53 hubs of DATAHUB.xlsx (INSERT IGNORE) and the two labels given
-- in the requirements (Sagaranten → "Kab. Sukabumi Sgr", Jampang Kulon →
-- "Kab. Sukabumi Jp"). Regenerate the hub list with:
--   npm run loader:hubs -- "DATAHUB.xlsx" --sql <file>
--
-- No new permission keys (uses loader.view / loader.manage_settings from 011).
-- Compatible with MySQL 5.7+ / MariaDB 10.2+. Idempotent.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `loader_hub_kota` (
  `id`            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `hub_key`       VARCHAR(150)  NOT NULL COMMENT 'normalized HUB: lowercase letters/digits only',
  `hub`           VARCHAR(150)  NOT NULL COMMENT 'DATAHUB HUB, e.g. Sukabumi Sagaranten LM',
  `dest_code`     VARCHAR(20)   NULL DEFAULT NULL COMMENT 'DATAHUB DEST CODE, e.g. SMI',
  `city`          VARCHAR(100)  NULL DEFAULT NULL COMMENT 'DATAHUB CITY, e.g. Sukabumi',
  `analytic_code` VARCHAR(30)   NULL DEFAULT NULL COMMENT 'DATAHUB ANALYTIC CODE = template Kode Gerai Terakhir',
  `hub_type`      VARCHAR(30)   NULL DEFAULT NULL COMMENT 'LAST MILE | FIRST MILE | SORTATION',
  `kota_penerima` VARCHAR(150)  NULL DEFAULT NULL COMMENT 'KOTA PENERIMA label; NULL = Kota_Tujuan fallback',
  `nama_pengirim` VARCHAR(150)  NULL DEFAULT NULL COMMENT 'NAMA PENGIRIM; NULL = SICEPAT <CITY>',
  `source`        VARCHAR(10)   NOT NULL DEFAULT 'manual' COMMENT 'seed | import | manual',
  `updated_by`    INT UNSIGNED  NULL DEFAULT NULL,
  `created_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loader_hub_key` (`hub_key`),
  KEY `idx_loader_hub_code` (`analytic_code`),
  CONSTRAINT `fk_loader_hub_user` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hubs of DATAHUB.xlsx (Sheet1).
INSERT IGNORE INTO loader_hub_kota
  (hub_key, hub, dest_code, city, analytic_code, hub_type, kota_penerima, nama_pengirim, source)
VALUES
  ('ciamisbanjarlm', 'Ciamis Banjar LM', 'TSI', 'Banjar', 'A1219003', 'LAST MILE', NULL, 'SICEPAT BANJAR', 'seed'),
  ('ciamiskawalilm', 'Ciamis Kawali LM', 'TSI', 'Ciamis', 'A1219002', 'LAST MILE', NULL, 'SICEPAT CIAMIS', 'seed'),
  ('ciamispusatlm', 'Ciamis Pusat LM', 'TSI', 'Ciamis', 'A1219001', 'LAST MILE', NULL, 'SICEPAT CIAMIS', 'seed'),
  ('cianjurcipanaslm', 'Cianjur Cipanas LM', 'CJR', 'Cianjur', 'A1205001', 'LAST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjurciranjanglm', 'Cianjur Ciranjang LM', 'CJR', 'Cianjur', 'A1205002', 'LAST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjurpusatfm', 'Cianjur Pusat FM', 'CJR', 'Cianjur', 'A1205010', 'FIRST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjurpusatlm', 'Cianjur Pusat LM', 'CJR', 'Cianjur', 'A1205022', 'LAST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjursindangbaranglm', 'Cianjur Sindangbarang LM', 'CJR', 'Cianjur', 'A1205004', 'LAST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjursortation', 'Cianjur Sortation', 'CJR', 'Cianjur', 'A1205020', 'SORTATION', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjursukanagaralm', 'Cianjur Sukanagara LM', 'CJR', 'Cianjur', 'A1205021', 'LAST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('cianjurtanggeunglm', 'Cianjur Tanggeung LM', 'CJR', 'Cianjur', 'A1205005', 'LAST MILE', NULL, 'SICEPAT CIANJUR', 'seed'),
  ('garutbungbulanglm', 'Garut Bungbulang LM', 'GRT', 'Garut', 'A1202004', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutcikeletlm', 'Garut Cikelet LM', 'GRT', 'Garut', 'A1202005', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutcisurupanlm', 'Garut Cisurupan LM', 'GRT', 'Garut', 'A1202006', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutkersamanahlm', 'Garut Kersamanah LM', 'GRT', 'Garut', 'A1202026', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutkotafm', 'Garut Kota FM', 'GRT', 'Garut', 'A1202028', 'FIRST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutpasirwangilm', 'Garut Pasirwangi LM', 'GRT', 'Garut', 'A1202027', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutsingajayalm', 'Garut Singajaya LM', 'GRT', 'Garut', 'A1202007', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutsortation', 'Garut Sortation', 'GRT', 'Garut', 'A1202025', 'SORTATION', NULL, 'SICEPAT GARUT', 'seed'),
  ('garutsukaweningmariparilm', 'Garut Sukawening Maripari LM', 'GRT', 'Garut', 'A1202002', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('garuttarogonglm', 'Garut Tarogong LM', 'GRT', 'Garut', 'A1202003', 'LAST MILE', NULL, 'SICEPAT GARUT', 'seed'),
  ('kuninganciawigebanglm', 'Kuningan Ciawigebang LM', 'KUN', 'Kuningan', 'A1215009', 'LAST MILE', NULL, 'SICEPAT KUNINGAN', 'seed'),
  ('kuninganjalaksanafm', 'Kuningan Jalaksana FM', 'KUN', 'Kuningan', 'A1215012', 'FIRST MILE', NULL, 'SICEPAT KUNINGAN', 'seed'),
  ('kuninganjalaksanalm', 'Kuningan Jalaksana LM', 'KUN', 'Kuningan', 'A1215008', 'LAST MILE', NULL, 'SICEPAT KUNINGAN', 'seed'),
  ('kuningansortation', 'Kuningan Sortation', 'KUN', 'Kuningan', 'A1215010', 'SORTATION', NULL, 'SICEPAT KUNINGAN', 'seed'),
  ('pangandaranlm', 'Pangandaran LM', 'TSI', 'Pangandaran', 'A1220001', 'LAST MILE', NULL, 'SICEPAT PANGANDARAN', 'seed'),
  ('subangciasemlm', 'Subang Ciasem LM', 'SBG', 'Subang', 'A1218003', 'LAST MILE', NULL, 'SICEPAT SUBANG', 'seed'),
  ('subangdawuanfm', 'Subang Dawuan FM', 'SBG', 'Subang', 'A1218005', 'FIRST MILE', NULL, 'SICEPAT SUBANG', 'seed'),
  ('subangjalancagaklm', 'Subang Jalan Cagak LM', 'SBG', 'Subang', 'A1218002', 'LAST MILE', NULL, 'SICEPAT SUBANG', 'seed'),
  ('subangpamanukanlm', 'Subang Pamanukan LM', 'SBG', 'Subang', 'A1218001', 'LAST MILE', NULL, 'SICEPAT SUBANG', 'seed'),
  ('subangsukamelanglm', 'Subang Sukamelang LM', 'SBG', 'Subang', 'A1218004', 'LAST MILE', NULL, 'SICEPAT SUBANG', 'seed'),
  ('sukabumicisaatlm', 'Sukabumi Cisaat LM', 'SMI', 'Sukabumi', 'A1203001', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumicitepuslm', 'Sukabumi Citepus LM', 'SMI', 'Sukabumi', 'A1203021', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumidayeuhluhurfm', 'Sukabumi Dayeuhluhur FM', 'SMI', 'Sukabumi', 'A1227002', 'FIRST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumijampangkulonlm', 'Sukabumi Jampang Kulon LM', 'SMI', 'Sukabumi', 'A1203009', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabuminagraklm', 'Sukabumi Nagrak LM', 'SMI', 'Sukabumi', 'A1203022', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumiparakansalaklm', 'Sukabumi Parakansalak LM', 'SMI', 'Sukabumi', 'A1228003', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumiparungkuda1fm', 'Sukabumi Parungkuda 1 FM', 'SMI', 'Sukabumi', 'A1228004', 'FIRST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumiparungkuda1lm', 'Sukabumi Parungkuda 1 LM', 'SMI', 'Sukabumi', 'A1203004', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumipasirhalanglm', 'Sukabumi Pasirhalang LM', 'SMI', 'Sukabumi', 'A1203014', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumipusatlm', 'Sukabumi Pusat LM', 'SMI', 'Sukabumi', 'A1203007', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumisagarantenlm', 'Sukabumi Sagaranten LM', 'SMI', 'Sukabumi', 'A1203010', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumisortation', 'Sukabumi Sortation', 'SMI', 'Sukabumi', 'A1203006', 'SORTATION', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('sukabumiwarungkiaralm', 'Sukabumi Warungkiara LM', 'SMI', 'Sukabumi', 'A1228002', 'LAST MILE', NULL, 'SICEPAT SUKABUMI', 'seed'),
  ('tasikmalayacikatomaslm', 'Tasikmalaya Cikatomas LM', 'TSI', 'Tasikmalaya', 'A1204001', 'LAST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayakarangnunggallm', 'Tasikmalaya Karangnunggal LM', 'TSI', 'Tasikmalaya', 'A1204002', 'LAST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayamangkubumifm', 'Tasikmalaya Mangkubumi FM', 'TSI', 'Tasikmalaya', 'A1240001', 'FIRST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayamangkubumilm', 'Tasikmalaya Mangkubumi LM', 'TSI', 'Tasikmalaya', 'A1204005', 'LAST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayarajapolahfm', 'Tasikmalaya Rajapolah FM', 'TSI', 'Tasikmalaya', 'A1204003', 'FIRST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayarajapolahlm', 'Tasikmalaya Rajapolah LM', 'TSI', 'Tasikmalaya', 'A1241002', 'LAST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayasingaparnafm', 'Tasikmalaya Singaparna FM', 'TSI', 'Tasikmalaya', 'A1204004', 'FIRST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayasingaparnalm', 'Tasikmalaya Singaparna LM', 'TSI', 'Tasikmalaya', 'A1241001', 'LAST MILE', NULL, 'SICEPAT TASIKMALAYA', 'seed'),
  ('tasikmalayasortation', 'Tasikmalaya Sortation', 'TSI', 'Tasikmalaya', 'A1204026', 'SORTATION', NULL, 'SICEPAT TASIKMALAYA', 'seed');

-- KOTA PENERIMA labels from the requirements (only while still unset, so a
-- re-run never overrides a label edited in the app).
UPDATE `loader_hub_kota` SET `kota_penerima` = 'Kab. Sukabumi Sgr'
 WHERE `hub_key` = 'sukabumisagarantenlm' AND `kota_penerima` IS NULL;
UPDATE `loader_hub_kota` SET `kota_penerima` = 'Kab. Sukabumi Jp'
 WHERE `hub_key` = 'sukabumijampangkulonlm' AND `kota_penerima` IS NULL;
