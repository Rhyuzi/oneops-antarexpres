-- ============================================================================
-- 014_rollback.sql — ROLLBACK of 014_master_wilayah.sql
-- Drops the wilayah master (children first: FK RESTRICT). The 3PL Loader
-- form then cannot resolve Cust ID / KOTA PENGIRIM / NAMA PENGIRIM and
-- refuses to process until 014 is applied again (or the code is rolled back).
-- Audit rows (storage_audit_logs) are kept: they are history.
-- ============================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `master_wilayah_kota`;
DROP TABLE IF EXISTS `master_cust_id`;
DROP TABLE IF EXISTS `master_wilayah`;
