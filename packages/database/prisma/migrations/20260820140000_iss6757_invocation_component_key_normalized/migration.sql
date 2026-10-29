-- ISS-6757, step 1 of 3: add the case-folded `component_key_normalized`
-- projection and the trigger that OWNS it.
--
-- WHAT THIS IS FOR. `invocationReadWhere`
-- (apps/api/app/agent-components/service/invocation-read.ts) resolves a
-- component detail's invocation page, and its fallback arm — the one that picks
-- up invocations no inventory row has claimed — filters:
--
--   agent_component_id IS NULL
--     AND component_kind = $1
--     AND component_key ILIKE $2        -- Prisma `mode: "insensitive"`
--
-- Prisma compiles `equals` + `mode: "insensitive"` to ILIKE (verified against
-- the emitted SQL on Prisma 7.8), and no btree index can serve ILIKE — not even
-- an expression index on `lower(component_key)`, which is why this migration
-- persists the folded value instead of indexing an expression the way ISS-6452
-- could. `agent_component_invocations` carries one row per component tool call
-- and has no `organization_id` column, so the only sargable predicate left was
-- `agent_component_id IS NULL`: the org scope arrives through the
-- generation -> session -> artifact join and the key match landed as a
-- post-scan filter. Both the capped `findMany` AND the UNCAPPED `groupBy`
-- (invocation-read.ts:53) run that same `where`, so the status counts could not
-- early-terminate the way the read's `take` implies.
--
-- MEASURED (EXPLAIN ANALYZE against this schema on a throwaway database with
-- every migration applied; 12 organizations, 420,000 invocations, one
-- production-like large tenant holding 200,000 of them, 288,000 unattributed;
-- the exact SQL Prisma emits for the orphan-only detail read, which passes an
-- EMPTY `inventoryIds` and is therefore the fallback arm alone —
-- detail-read-orphan.ts:145):
--
--   before  Parallel Seq Scan on agent_component_invocations
--             Rows Removed by Filter: 137200 (per worker; 411,600 discarded)
--             Buffers: shared hit=6152 read=7698   Execution Time: 65.1 ms
--   after   Bitmap Index Scan on idx_aci_kind_key_normalized_unattributed
--             Index Cond: ((component_kind = …) AND (component_key_normalized = …))
--             Buffers: shared hit=196              Execution Time: 1.7 ms
--
-- The whole-table scan becomes O(rows carrying that key), so the cost stops
-- scaling with total ingest volume. The mixed arm (a component that DOES have
-- inventory rows, so the fallback ORs with `agent_component_id IN (…)`)
-- improves too, measured single-threaded on both sides for a like-for-like
-- comparison: 93.1 ms / 13,648 buffers -> 58.6 ms / 5,590 buffers, the fallback
-- half now reaching the Index Cond inside a BitmapOr. The index is built in
-- step 3 (migration 20260820140200); this file only adds the column and its
-- writer.
--
-- WHY A TRIGGER OWNS THE COLUMN, NOT THE APPLICATION (hand-written SQL; Prisma
-- cannot express a trigger — same treatment as the audit-ledger append-only
-- trigger in 20260723034629_fea3856_add_audit_entries, and the integrity
-- triggers in 20260818170000_iss6980_branch_activity_integrity). Three things
-- make an app-level write wrong here:
--
--   * There are two writers, and one of them is raw SQL. Ingest stages rows
--     through `mapInvocationCreate`, but `applyResolutionUpdates`
--     (agent-sessions/service/component-invocations.ts) RE-POINTS
--     `component_key` for an ISS-4923 skill-shadowed phantom inside a
--     `jsonb_to_recordset` UPDATE. A derived column maintained by hand has to
--     be remembered in both, forever.
--   * The deploy window. `prisma migrate deploy` runs in `@repo/database`'s
--     prebuild, so the column exists BEFORE the code that would populate it is
--     serving. Every row the previous build writes in that window would carry
--     NULL — and be permanently invisible to the new read, which is exactly the
--     silently-dropped-rows failure this table's readers must not have. The
--     trigger is live the instant this migration commits, so the old build's
--     inserts are folded too.
--   * `ADD COLUMN` holds ACCESS EXCLUSIVE, so no concurrent writer can slip a
--     row in between the column appearing and the trigger existing. Combined
--     with step 2's backfill of the rows that predate this file, that leaves no
--     NULL window at all.
--
-- `UPDATE OF component_key, component_key_normalized` narrows the trigger to
-- statements that actually name one of those columns, so the hot
-- `relinkActiveForComputeTarget` repair (which sets only `agent_component_id`,
-- `attribution_status`, `updated_at`) does not pay for it. The DERIVED column is
-- in that list because Prisma exposes it as writable (whitlockk): the trigger only
-- OWNS the projection if a statement that names it directly is re-folded too,
-- and the trigger's assignment is unconditional, so such an update writes
-- `lower(NEW.component_key)` rather than the caller's value. Without it, one
-- `UPDATE … SET component_key_normalized = …` — a stray Prisma write, a
-- hand-run repair — would persist a value the equality read cannot match, and
-- the row would silently drop out of its component's detail page. Measured cost
-- on the paths that DO fire it: a 240,000-row bulk insert went from 1.90 s to
-- 2.53 s on a synthetic table — real ingest does far more per row, so the
-- relative overhead is smaller than that, and it buys an invariant no reviewer
-- has to re-verify at each new write site.
--
-- `lower()` not `upper()`, and folded in SQL on the write side: the read side
-- folds the requested key with `normalizeAgentComponentInvocationKey`
-- (packages/api/src/types/agent-component-invocation.ts), whose contract is
-- pinned against this expression by
-- `__tests__/integration/iss6757-invocation-component-key-normalized.integration.test.ts`
-- so the two cannot drift apart silently.
--
-- ADDITIVE: one nullable column and one trigger. No column dropped, no type
-- altered, no row deleted, and no existing value overwritten.

-- AlterTable
ALTER TABLE "agent_component_invocations" ADD COLUMN     "component_key_normalized" TEXT;

CREATE OR REPLACE FUNCTION agent_component_invocations_fold_component_key()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW."component_key_normalized" := lower(NEW."component_key");
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_aci_fold_component_key
BEFORE INSERT OR UPDATE OF "component_key", "component_key_normalized" ON "agent_component_invocations"
FOR EACH ROW
EXECUTE FUNCTION agent_component_invocations_fold_component_key();
