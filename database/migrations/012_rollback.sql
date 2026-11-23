-- ============================================================================
-- 012_rollback.sql — ROLLBACK of 012_loader_hub_kota.sql
-- Drops the gerai / HUB master. The Result 3PL then uses the Kota_Tujuan
-- fallback for KOTA PENERIMA on every row (reported).
-- ============================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `loader_hub_kota`;
