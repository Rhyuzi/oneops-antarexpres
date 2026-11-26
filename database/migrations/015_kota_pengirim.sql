-- ============================================================================
-- 015_kota_pengirim.sql — KOTA PENGIRIM per breakdown kota. Requires 014.
--
-- Adds master_wilayah_kota.kota_pengirim (editable in Master Data → Kota per
-- wilayah, audited). KOTA PENGIRIM of the JNE file:
--   1. the selected kota's kota_pengirim, when set;
--   2. otherwise "" for Tasikmalaya, else the wilayah name (rule of 014).
--
-- Seed (Tasikmalaya): Mangkubumi, Singaparna, Sukaraja (alias sukareja) →
-- "Tasikmalaya"; Ciamis → "Ciamis"; Banjar, Pangandaran … stay NULL → empty.
-- Only NULL values are filled, so values edited in the app are kept.
-- Idempotent. MariaDB 10.2+ (ADD COLUMN IF NOT EXISTS).
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE `master_wilayah_kota`
  ADD COLUMN IF NOT EXISTS `kota_pengirim` VARCHAR(100) NULL DEFAULT NULL
  COMMENT 'KOTA PENGIRIM for this kota; NULL = wilayah rule (Tasikmalaya empty, else wilayah name)'
  AFTER `aliases`;

UPDATE master_wilayah_kota k
  JOIN master_wilayah w ON w.id = k.wilayah_id
   SET k.kota_pengirim = 'Tasikmalaya'
 WHERE w.name_key = 'tasikmalaya'
   AND k.kota_key IN ('mangkubumi', 'singaparna', 'sukaraja', 'sukareja')
   AND k.kota_pengirim IS NULL;

UPDATE master_wilayah_kota k
  JOIN master_wilayah w ON w.id = k.wilayah_id
   SET k.kota_pengirim = 'Ciamis'
 WHERE w.name_key = 'tasikmalaya'
   AND k.kota_key = 'ciamis'
   AND k.kota_pengirim IS NULL;
