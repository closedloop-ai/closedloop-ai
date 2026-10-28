-- ISS-7229: Claude's OWN reported cost for a session, rolled up onto the session
-- row from the `claude_code_cost_event` rows Claude Code exports over OTel.
--
-- WHY A COLUMN AND NOT A READ-TIME SUM. The figure has to cross the desktop ->
-- cloud sync boundary and land in `session_detail.authoritative_cost_usd`, and
-- the sync payload is built per session from the session row. A read-time
-- aggregate would also be recomputed by every consumer, and the cloud has no
-- `claude_code_cost_event` table to recompute it from at all.
--
-- WHY IT REPLACES THE LOOP PROJECTION. The cloud column has been fed since
-- #5790 by projecting `loop_events.data.usageReconciliation.authoritativeCostUsd`
-- onto whichever session claimed the loop. That can only ever answer for a
-- session that claimed a loop, and the figure is a property of the RUN, not of
-- the loop that happened to drive it. Sourcing it here makes the loop case an
-- instance of the general one.
--
-- NULLABLE WITH NO DEFAULT. `null` means no cost events were captured for this
-- session -- the majority of rows, since capture is gated on the
-- `claudeCodeOtelCapture` Labs setting and only reaches sessions whose Claude
-- process was pointed at the local receiver. A `0` is a REPORTED zero and a real
-- measurement, and the two must never collapse.
--
-- WHAT KEEPS THEM APART IS SQL'S OWN `SUM`, not a guard the writer adds. `SUM`
-- over zero rows is NULL; `SUM` over rows that really do total zero is 0.
-- Verified against sqlite3: `CREATE TABLE e(c DECIMAL); SELECT SUM(c),
-- typeof(SUM(c)) FROM e;` yields NULL/`null`, while the same query over a single
-- `0` row yields 0/`integer`. So the rollup uses a BARE `SUM` and the reflex
-- `COALESCE(SUM(...), 0)` is the bug, not the fix: it would stamp a confident
-- "Claude reported $0.00" on every session that was never captured at all.
--
-- DECLARED DECIMAL to match `claude_code_cost_event.cost_usd`, the column it
-- sums, and the `Decimal(14,6)` cloud counterpart it syncs to -- so the Prisma
-- mapping is a `Decimal` on both sides of the hop.
--
-- IT DOES NOT BUY EXACTNESS HERE, and an earlier draft of this comment claimed
-- it did. SQLite gives a DECIMAL column NUMERIC affinity, so a non-integer
-- lands as an 8-byte float: `CREATE TABLE t(c DECIMAL); INSERT INTO t
-- VALUES(0.1),(0.2); SELECT typeof(c)` returns `real`, and `SUM` over it returns
-- `real`. `cost_usd` is stored the same way, so this sum is float arithmetic
-- over float inputs either way. The declaration is right; the exactness reason
-- was not.
--
-- Purely additive: one new nullable column. No existing row is rewritten, no
-- existing column changes type, and every session predates it as NULL -- which
-- is the correct reading, not a gap: none of them has a captured figure until
-- the rollup runs.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "authoritative_cost_usd" DECIMAL;

-- Backfill from the cost events THIS INSTALL ALREADY HAS.
--
-- ISS-7352 shipped `claude_code_cost_event` before this column existed, so an
-- upgrading install can hold captured cost for sessions that will never be
-- rolled up otherwise: the two runtime seams fire on a new OTel export and on a
-- transcript import, and a quiet completed run gets neither. Without this pass
-- their evidence sits in the local database while the column stays NULL
-- indefinitely.
--
-- Same statement the runtime rollup uses, applied to every session at once. The
-- bare `SUM` is doing the same work here it does there: a session with no events
-- gets NULL rather than a fabricated 0, so this cannot invent a figure for the
-- sessions it does not cover. Restricting to `IS NULL` rows makes it idempotent
-- and keeps it from touching anything a later runtime rollup has since written.
UPDATE "sessions"
SET "authoritative_cost_usd" = (
  SELECT SUM("cost_usd")
  FROM "claude_code_cost_event"
  WHERE "session_id" = "sessions"."id"
)
WHERE "authoritative_cost_usd" IS NULL;
