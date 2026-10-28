-- ISS-12781: drops two `agent_component_invocations` indexes that no query uses.
-- On 2026-10-20 the table took 6.67M inserted and 7.70M updated rows (Datadog
-- DBM) and deletes nearly as many as it inserts (142.3M against 146.5M since
-- creation); every inserted or non-HOT-updated row writes every index.
--
-- Production `pg_stat_user_indexes`, read 2026-10-21 03:28 UTC (statistics
-- unreset since 2025-03-25; this table was created 2026-07-23):
--   idx_aci_status_invoked_at            685 MB  idx_scan 0, never scanned
--   idx_aci_component_branch_invoked_at  653 MB  idx_scan 284,661, last 2026-08-11
-- No reader filters invocations by `attribution_status` or by
-- `(agent_component_id, branch_name)`: the session tree read
-- (session-invocation-tree-read.ts) goes through the generation, the component
-- read (invocation-read.ts) by `agent_component_id IN` or the folded
-- kind/key, ancestry (invocation-ancestry.ts) by generation and external id. The
-- `fk_aci_component` lookup keeps `idx_aci_component_invoked_at`, which leads
-- with the same column and was scanned 2026-10-20.
--
-- Kept: `idx_aci_definition_version_invoked_at` (633 MB, idx_scan 0) is the only
-- index leading with `definition_version_id`, so it serves the
-- `fk_aci_definition_version` ON DELETE SET NULL lookup when a definition
-- version is deleted; and `agent_component_invocations_part_id_idx` serves the
-- `fk_aci_part` cascade on every part delete.
--
-- A plain DROP INDEX, as 20261006120400_iss11212_drop_superseded_reconcile_index
-- does: check-destructive-migrations rejects DROP INDEX CONCURRENTLY in any
-- migration. The drop only unlinks catalog entries, so its ACCESS EXCLUSIVE
-- lock lasts for that change; `lock_timeout` bounds the wait behind a long
-- transaction, so writers do not queue behind it.
SET lock_timeout = '5s';

-- index-lock-ok(agent_component_invocations): dropping an index unlinks catalog entries without scanning or rewriting the table, so the ACCESS EXCLUSIVE lock lasts only for that change, lock_timeout bounds its wait behind a long transaction, and DROP INDEX CONCURRENTLY is rejected by this gate
-- DropIndex
DROP INDEX IF EXISTS "idx_aci_status_invoked_at";

-- DropIndex
DROP INDEX IF EXISTS "idx_aci_component_branch_invoked_at";

RESET lock_timeout;
