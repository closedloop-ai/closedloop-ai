-- ISS-8517: make `session_detail.estimated_cost` tell the truth on the historical
-- rows that hold a `$0` nothing ever measured.
--
-- Hand-written on purpose (packages/database/AGENTS.md): a pure DATA migration.
-- No schema change, so `prisma migrate dev` has nothing to generate and reports
-- no drift. This is the repair 20260903000000 (ISS-8515) handed off: "No row is
-- rewritten. Existing zeros stay zero; repairing them is ISS-8517."
--
-- On rows written before ISS-8515, a stored `0` means EITHER "this session
-- genuinely cost $0" OR "nothing ever priced it and the column defaulted". This
-- file has TWO ARMS, one for each way that ambiguity can be resolved from data
-- already in the database. They are disjoint by construction (see DISJOINT
-- below) and they run in this order:
--
--   ARM 1 — A REAL FIGURE EXISTS, so copy it. The desktop's own whole-session
--   rollup holds a POSITIVE `estimated_cost`, so a measurement provably existed
--   and this column failed to receive it. Write that figure.
--
--   ARM 2 — NOTHING WAS EVER MEASURED, so say so. No `agent_session_token_usage`
--   rows, and no rollup carrying either a positive cost or a positive token
--   count. The stored `0` is a fabricated measurement. Write NULL, which is the
--   column's spelling of "unknown" since ISS-7813 made it nullable.
--
-- ARM 2 MIRRORS THE DESKTOP'S OWN RULE, it does not invent one.
-- `sessionEstimatedCostSql` (apps/desktop/src/main/database/token-cost-writes.ts)
-- returns NULL for a session that is fully priced with NO evidence at all — no
-- token rows, no web-search line item — and returns 0 only when priced rows
-- actually summed to zero. The desktop calls this population UNKNOWN; the cloud
-- calls it $0. Measured against a real desktop database on 2026-09-03: of 7,652
-- sessions matched on `external_session_id`, 448 are NULL on the desktop while
-- the cloud holds `0`, all of them zero-token, and ZERO are positive on the
-- desktop while the cloud holds `0`. Arm 2 makes the cloud agree with the
-- machine that did the measuring. This is the ISS-7818 "confident zero".
--
-- WHERE ARM 1'S VALUE COMES FROM, and why it is not the per-model token table.
-- `persistSessionAnalytics` (apps/api/app/agent-sessions/service/
-- persist-session-children.ts) writes `agent_session_usage_rollups.estimated_cost`
-- and `session_detail.estimated_cost` from ONE wire field,
-- `sessionAnalytics.estimatedCostUsd`, in one transaction — the rollup as
-- `roundCost(… ?? 0)`, `session_detail` null-preserving — and that write runs
-- after, and wins over, the token-derived write from `resolveTokenRollupColumns`.
-- The rollup is not a second opinion; it is the same number, minus the null.
--
-- `SUM(agent_session_token_usage.estimated_cost)` is the WRONG source, three ways:
-- ISS-7176 ruled on 2026-08-20 that `token_usage` is not a cost source; it is not
-- the winning writer, so a later sync would overwrite it; and it is precisely the
-- token-only figure this ticket's acceptance criteria say no sync may restore.
--
-- ARM 2 NAMES THAT TABLE, AND READS IT AS EVIDENCE ONLY. `NOT EXISTS (SELECT 1
-- FROM "agent_session_token_usage" …)` asks whether any per-model row exists at
-- all. It does not read `estimated_cost` there, does not sum it, and no value
-- from that table reaches a `SET`. The rejection above is about SOURCING A COST
-- from it; an existence probe is the opposite — it is how arm 2 proves nothing
-- was measured. The migration test pins that distinction: the table may appear
-- exactly once, inside that probe, and no column of it may appear anywhere.
--
-- ARM 1 IS POSITIVE-ONLY, and that is its whole safety argument. The rollup
-- column is `NOT NULL DEFAULT 0`, so a `0` THERE is as ambiguous as the `0` here.
-- `> 0` restricts arm 1 to rows where a real measurement provably exists. A
-- rollup `0` is not copied by arm 1 — it is handed to arm 2, which writes NULL
-- rather than re-affirming a number nobody produced.
--
-- Four properties follow from the statements' shape rather than from an argument
-- about the data. Neither arm can LOWER a positive figure (both populations admit
-- only `NULL` or `0`, and both re-check that in the UPDATE itself). Neither can
-- FABRICATE one (arm 1 copies a figure another writer persisted — no arithmetic
-- anywhere; arm 2 writes NULL, which asserts nothing). Neither can FAN OUT
-- (`artifact_id` is the PRIMARY KEY of both tables, so arm 1's join is 1:1 by
-- construction, and arm 2 joins only its own candidate list). And both are
-- IDEMPOTENT (a repaired row leaves its arm's population, so a re-run matches
-- nothing the first pass wrote).
--
-- DISJOINT BY CONSTRUCTION, two ways over. A row arm 1 writes has a rollup with
-- `estimated_cost > 0`, which fails arm 2's second `NOT EXISTS`; and arm 1 leaves
-- it holding a positive value, which fails arm 2's `= 0`. Arm 2 also requires an
-- exact `0`, so it never touches a row that is already NULL. Order is arm 1 then
-- arm 2, and the ordering is not load-bearing — it is stated so the reader does
-- not have to work out whether it is.
--
-- POPULATION, MEASURED ON PRODUCTION 2026-09-03 (Tamsin, prod read-only user;
-- staging in parentheses). This is measured, not estimated:
--
--   session_detail rows                      29,345
--     estimated_cost = 0                      9,184
--     estimated_cost IS NULL                    488
--     estimated_cost > 0                     19,673
--   ARM 1 writes                                  0  (0)
--   ARM 2 writes                              9,184  (644)
--
-- Every one of the 9,672 zero-or-NULL rows has a rollup row whose cost is 0 and
-- whose four token counts are 0, has zero `agent_session_token_usage` rows, has
-- zero `agent_session_token_events` rows, and has `authoritative_cost_usd` NULL.
-- They satisfy the priceable predicate on `turns > 0` alone, averaging 1 turn.
-- No source anywhere in the database holds a positive figure for any of them.
--
-- ARM 1'S POPULATION IS EMPTY TODAY, AND THE ARM STAYS ANYWAY — deliberately,
-- not by oversight. It is the shape a later run duplicates when a positive rollup
-- does sit beside an unknown detail, and deleting it would mean re-deriving the
-- source ruling above from scratch. It writes nothing on this deploy.
--
-- RULING (Tamsin, 2026-09-03): THE ROLLUP IS ACCEPTED AS-IS, WITH NO VINTAGE
-- FILTER. The rollup write is not freshness-gated while the `session_detail`
-- write is — in `persistSessionAnalytics` the gate guards only the latter — so a
-- rollup can in principle hold an older-vintage positive figure beside a newer,
-- genuinely-zero detail, and arm 1 would copy it. `rollup_updated_at` /
-- `last_synced_at` are NOT consulted: picking a vintage rule would invent a
-- freshness semantics the application does not itself apply to this column.
-- Ruled acceptable because arm 1's population is 0 rows today, so there is
-- nothing to protect, and because the figure is one a real writer produced.
--
-- WHAT THIS STILL DOES NOT GUARANTEE. Both limits live in the WRITE path, which
-- this ticket excludes ("Excludes: Desktop production behavior, writer ownership,
-- and DEFAULT removal"). Recorded so the next reader does not re-derive them.
--
--   1. A VERSION-SKEWED DESKTOP CAN STILL RESTORE A TOKEN-ONLY FIGURE. The
--      `anyRowPriced` branch of `resolveTokenRollupColumns` returns its sum
--      without consulting `hasStoredEstimatedCost`, and `persistSessionAnalytics`
--      early-returns on `if (!analytics)`. An older build sending priced token
--      rows and no `sessionAnalytics` writes the token sum and nothing corrects
--      it. Not made worse here: such a row holds that figure either way.
--   2. A LATER SYNC CAN WRITE `0` BACK OVER AN ARM 2 NULL, because ISS-8515
--      removed the column DEFAULT but not the writer's `?? 0` on other paths.
--      Arm 2 is a repair of the existing corpus, not a guarantee about the
--      future; the write-path fix is out of scope for this ticket.
--
-- IRREVERSIBLE, BOTH ARMS. This repo has no down-migration convention, and this
-- could not honour one anyway. After arm 1 the database no longer records whether
-- the row held `NULL` or `0`. After arm 2 it no longer records that the row held
-- `0` at all — a `$0` and a NULL are indistinguishable afterwards, which is
-- exactly why NULL is the honest value to leave behind: it is the one that does
-- not claim a measurement. Re-running is safe; that is not the same as
-- reversible. The pre-migration state must come from a backup or PITR snapshot.
-- FORWARD-ONLY.
--
-- ONE `DO` BLOCK, for the reason plpgsql exists: the ceiling is a DECLARED
-- constant that both arms compare against and both `RAISE`s interpolate, and
-- `IF … THEN RAISE` is control flow plain SQL cannot express. It is NOT what lets
-- the test execute the shipped file — node-pg sends a parameterless string over
-- the simple query protocol, so a multi-statement file would execute and abort
-- identically. What the shape buys is that no statement sits OUTSIDE the block
-- the ceiling protects.
--
-- THE CEILING, AND WHY SELECTION AND WRITE ARE NOW ONE STATEMENT. An earlier
-- draft counted the population in one statement and wrote it in the next. Under
-- READ COMMITTED those take separate snapshots, so a row committing in between
-- was repaired without ever having been counted — the guard bounded a population
-- the UPDATE no longer had (marisolashgrove, review of `b4ce40883`). Each arm is now
-- a single statement: a `MATERIALIZED` candidate CTE with `LIMIT
-- max_inline_rows + 1`, a data-modifying CTE that writes exactly those candidates,
-- and one snapshot across both. `LIMIT` is therefore a HARD CAP on rows touched,
-- not merely on a number that gets compared — a population of ten million can
-- still only put `max_inline_rows + 1` rows under lock.
--
-- The guard now fires AFTER its arm's write rather than before it, and that is
-- the trade the atomicity buys. `RAISE EXCEPTION` aborts the transaction, so the
-- write does not commit and the deploy fails having changed nothing; what it no
-- longer does is prevent the rows being touched in the first place. Bounded at
-- `max_inline_rows + 1` rows, that is the same lock exposure the old preflight
-- was sizing for.
--
-- THE COUNT COMPARED AGAINST THE CEILING IS THE SELECTED SET, NOT THE WRITTEN
-- ONE. The UPDATE re-checks the population predicate in its own `WHERE` so a
-- concurrent writer that has just put a real figure on a candidate row keeps it
-- (Read Committed re-evaluates that predicate against the updated row). Written
-- can therefore be lower than selected, and it is selected that describes how
-- many rows the statement was willing to lock — so selected is what the ceiling
-- reads.
--
-- ONE CEILING PER ARM, not one shared budget. The two populations are disjoint
-- and each arm is its own statement, so a shared budget would abort an arm whose
-- own population fits, and its failure message could not say which arm was too
-- big. The cost is that the worst case for the whole transaction is 2 ×
-- max_inline_rows rows rather than one — ~145 s at the rate measured below, on a
-- transaction nothing times out (see WHAT THE 300 s IS). Today's measured sum is
-- 9,184 rows.
--
-- MEASURED on a `(LIKE … INCLUDING ALL)` clone of both tables — same columns,
-- defaults and full index set — on a laptop-class Docker Postgres 16.14,
-- 2,000,000 sessions against 2,000,000 rollups: 899,889 rows rewritten in 260.5 s,
-- i.e. ~3,450 rows/s. 250,000 rows is ~72 s at that rate, which still fits on an
-- instance several times slower.
--
-- WHAT THE 300 s IS, PRECISELY — it does NOT bound these statements.
-- `MIGRATION_SERIALIZE_LOCK_BUDGET_MS` (packages/database/scripts/migration-lock.ts)
-- is the `statement_timeout` that `withMigrationSerializeLock` puts on its OWN
-- dedicated connection while that connection blocks on `pg_advisory_lock`.
-- `migrate deploy` runs as `fn()`, after the lock is held and on a different
-- connection, so overrunning 300 s would not cancel this migration. The hazard is
-- the other direction: a CONCURRENT deploy waiting on the serialize lock gives up
-- at 300 s and FAILS OPEN, which is the Prisma advisory-lock contention the gate
-- exists to prevent. (The ISS-6756 precedent frames this as a bound on its own
-- statement; that framing is imprecise and is deliberately not copied.)
--
-- NO `SET lock_timeout`, deliberately — this is not 20260903000000's shape. That
-- migration took ACCESS EXCLUSIVE for a catalog change, where the hazard is
-- queueing behind a long-running reader. This is a data write: ROW EXCLUSIVE plus
-- row locks, blocking neither reads nor inserts. It DOES block a concurrent
-- UPDATE of a row it is rewriting for the life of the transaction, and desktop
-- sync updates this table (`sessionDetail.upsert`), so at the ceiling that is a
-- ~72 s stall for an ingest touching one of those rows — small, because such a
-- row is by definition one nothing has priced, but not nothing.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED BY EITHER ARM. It is a Prisma
-- `@updatedAt` column with no database default and no trigger, so a raw `UPDATE`
-- that does not name it leaves it alone. That column is the Sessions list's
-- "Updated" value and its `sortBy=updated` key, so touching it would jerk every
-- repaired session to the top of that sort for a change no user made. The
-- migration test pins that each statement assigns `estimated_cost` and nothing
-- else.
--
-- TWO CLAUSES ARE REDUNDANT IN FILE ORDER AND KEPT ON PURPOSE, because each
-- arm's predicate is ALSO executed standalone — by the pre-deploy count and by
-- the drain, neither of which has run the other arm first.
--
--   · Arm 2's `r."estimated_cost" > 0` probe term. Within one successful run it
--     can never select anything, because arm 1 has already repaired every row
--     with a positive rollup beside a `NULL`-or-`0` detail. Run arm 2's drain on
--     its own, though, and that term is the only thing stopping it writing NULL
--     over a session the rollup can price. Its mutation is therefore killed by
--     the text pin and NOT by an executed case — stated rather than papered over
--     with a case that would not really cover it.
--   · Arm 1's `IS DISTINCT FROM`, below.
--
-- EACH UPDATE RE-STATES ITS POPULATION PREDICATE, and that re-check is load-
-- bearing twice over: it is what makes Read Committed re-evaluate the row a
-- concurrent writer has just changed, and it is what keeps a widened candidate
-- CTE from writing anything it should not. Measured by mutation: widening either
-- arm's CTE predicate ALONE changes no row, because the write-side check still
-- refuses. Both copies have to go before a real figure moves.
--
-- `IS DISTINCT FROM` in arm 1 is REDUNDANT and kept on purpose: given the
-- population the stored value is `NULL` or `0` and the source is `> 0`, so they
-- always differ. It stays because it keeps the no-op-on-rerun property LOCAL to
-- the statement — if the population predicate is ever widened, idempotence does
-- not silently start depending on a clause elsewhere in the `WHERE`.
--
-- RECOVERY, if either ceiling fires. The three steps are in the RAISE MESSAGE,
-- not only the HINT, on purpose: `migrate-deploy-recovery.ts` parses P0001 output
-- with `/Database error:\s*(?:ERROR:\s*)?([^\n]+)/` — the first LINE only — and
-- prints that as `Invariant:`. Postgres carries HINT as a separate field, so a
-- hint-only remedy can be dropped before an operator ever sees it. Read the two
-- counts BEFORE deploying rather than after; a fired ceiling is a FAILED
-- production deploy for everyone, not a skipped repair.
--
--   -- ARM 1 population:
--   SELECT count(*)
--     FROM "session_detail" AS s
--     JOIN "agent_session_usage_rollups" AS r ON r."artifact_id" = s."artifact_id"
--    WHERE r."estimated_cost" > 0
--      AND (s."estimated_cost" IS NULL OR s."estimated_cost" = 0)
--      AND s."estimated_cost" IS DISTINCT FROM r."estimated_cost";
--
--   -- ARM 2 population:
--   SELECT count(*)
--     FROM "session_detail" AS s
--    WHERE s."estimated_cost" = 0
--      AND NOT EXISTS (SELECT 1 FROM "agent_session_token_usage" AS u
--                       WHERE u."agent_session_id" = s."artifact_id")
--      AND NOT EXISTS (SELECT 1 FROM "agent_session_usage_rollups" AS r
--                       WHERE r."artifact_id" = s."artifact_id"
--                         AND (r."estimated_cost" > 0
--                              OR r."input_tokens" + r."output_tokens"
--                                 + r."cache_read_tokens"
--                                 + r."cache_write_tokens" > 0));
--
-- THE DRAIN, referenced by both messages. Run in psql AUTOCOMMIT — NOT inside a
-- transaction, since the point is that each batch commits and releases its row
-- locks. Run whichever arm's ceiling fired; repeat until it reports 0.
--
--   \set batch 20000
--
--   -- ARM 1:
--   WITH stale AS (
--     SELECT s."artifact_id", r."estimated_cost" AS repaired_cost
--       FROM "session_detail" AS s
--       JOIN "agent_session_usage_rollups" AS r
--         ON r."artifact_id" = s."artifact_id"
--      WHERE r."estimated_cost" > 0
--        AND (s."estimated_cost" IS NULL OR s."estimated_cost" = 0)
--        AND s."estimated_cost" IS DISTINCT FROM r."estimated_cost"
--      LIMIT :batch
--        FOR UPDATE OF s SKIP LOCKED
--   )
--   UPDATE "session_detail" AS s
--      SET "estimated_cost" = stale."repaired_cost"
--     FROM stale
--    WHERE s."artifact_id" = stale."artifact_id";
--
--   -- ARM 2:
--   WITH stale AS (
--     SELECT s."artifact_id"
--       FROM "session_detail" AS s
--      WHERE s."estimated_cost" = 0
--        AND NOT EXISTS (SELECT 1 FROM "agent_session_token_usage" AS u
--                         WHERE u."agent_session_id" = s."artifact_id")
--        AND NOT EXISTS (SELECT 1 FROM "agent_session_usage_rollups" AS r
--                         WHERE r."artifact_id" = s."artifact_id"
--                           AND (r."estimated_cost" > 0
--                                OR r."input_tokens" + r."output_tokens"
--                                   + r."cache_read_tokens"
--                                   + r."cache_write_tokens" > 0))
--      LIMIT :batch
--        FOR UPDATE OF s SKIP LOCKED
--   )
--   UPDATE "session_detail" AS s
--      SET "estimated_cost" = NULL
--     FROM stale
--    WHERE s."artifact_id" = stale."artifact_id";
--
-- EACH ARM'S SELECTION PREDICATE IS WRITTEN THREE TIMES AND ALL THREE MOVE
-- TOGETHER: the candidate CTE below, the pre-deploy count above, and the drain
-- above. Only the first is pinned — the unit test reads `migrationDdl`, which
-- strips comments, so the two copies that live in comments are invisible to it
-- for the same reason the USING HINT text is. Narrowing or widening an arm means
-- editing all three by hand: a drain wider than the statement writes costs this
-- migration deliberately refuses, and a narrower one never clears the ceiling the
-- re-run has to get under. (The UPDATE's re-check is a fourth, partial copy on
-- purpose — it is the concurrency guard described above, not a second selection.)
--
-- This migration stands alone — unlike ISS-6756 there is no sibling to re-apply
-- or resolve by hand, and because both arms are idempotent, draining fully before
-- a first deploy simply makes it a no-op rather than something to resolve.

DO $iss8517$
DECLARE
  -- ~72 s per arm at the ~3,450 rows/s measured above.
  max_inline_rows CONSTANT bigint := 250000;
  priced_selected bigint;
  priced_written bigint;
  unknown_selected bigint;
  unknown_written bigint;
BEGIN
  -- ARM 1: a positive rollup vouches for a real measurement this column missed.
  WITH candidates AS MATERIALIZED (
    SELECT s."artifact_id", r."estimated_cost" AS repaired_cost
      FROM "session_detail" AS s
      JOIN "agent_session_usage_rollups" AS r
        ON r."artifact_id" = s."artifact_id"
     WHERE r."estimated_cost" > 0
       AND (s."estimated_cost" IS NULL OR s."estimated_cost" = 0)
       AND s."estimated_cost" IS DISTINCT FROM r."estimated_cost"
     LIMIT max_inline_rows + 1
  ), repaired AS (
    UPDATE "session_detail" AS s
       SET "estimated_cost" = c."repaired_cost"
      FROM candidates AS c
     WHERE s."artifact_id" = c."artifact_id"
       AND (s."estimated_cost" IS NULL OR s."estimated_cost" = 0)
       AND s."estimated_cost" IS DISTINCT FROM c."repaired_cost"
    RETURNING s."artifact_id"
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM repaired)
    INTO priced_selected, priced_written;

  IF priced_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-8517 arm 1 (copy the priced rollup): more than % session_detail rows still need the estimated_cost repair; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20260903140000_iss8517_backfill_session_detail_estimated_cost`, then the arm 1 batched drain in that migration''s header until it reports 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and stands alone — no sibling migration needs attention. Nothing it wrote was committed. The three recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  -- ARM 2: nothing anywhere measured this session, so the stored 0 is fabricated.
  WITH candidates AS MATERIALIZED (
    SELECT s."artifact_id"
      FROM "session_detail" AS s
     WHERE s."estimated_cost" = 0
       AND NOT EXISTS (
         SELECT 1
           FROM "agent_session_token_usage" AS u
          WHERE u."agent_session_id" = s."artifact_id"
       )
       AND NOT EXISTS (
         SELECT 1
           FROM "agent_session_usage_rollups" AS r
          WHERE r."artifact_id" = s."artifact_id"
            AND (r."estimated_cost" > 0
                 OR r."input_tokens" + r."output_tokens"
                    + r."cache_read_tokens" + r."cache_write_tokens" > 0)
       )
     LIMIT max_inline_rows + 1
  ), cleared AS (
    UPDATE "session_detail" AS s
       SET "estimated_cost" = NULL
      FROM candidates AS c
     WHERE s."artifact_id" = c."artifact_id"
       AND s."estimated_cost" = 0
    RETURNING s."artifact_id"
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM cleared)
    INTO unknown_selected, unknown_written;

  IF unknown_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-8517 arm 2 (clear the fabricated zero): more than % session_detail rows still hold an unmeasured zero; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20260903140000_iss8517_backfill_session_detail_estimated_cost`, then the arm 2 batched drain in that migration''s header until it reports 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and stands alone — no sibling migration needs attention. Nothing it wrote was committed, including arm 1. The three recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  RAISE NOTICE 'ISS-8517: arm 1 wrote % of % selected; arm 2 wrote % of % selected.',
    priced_written, priced_selected, unknown_written, unknown_selected;
END
$iss8517$;
