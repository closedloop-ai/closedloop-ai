-- ISS-8674: bound the queue-depth sampler's DATABASE work, not just its output.
--
-- WHAT WAS UNBOUNDED. `countQueuedCommandsByTarget` grouped `desktop_commands`
-- by target over `status = 'queued'`. Prisma's `take` compiles to a LIMIT
-- applied AFTER `GROUP BY … ORDER BY count(*)`, so Postgres aggregated every
-- queued row on every five-minute tick and the cap only discarded the losing
-- groups. The read was therefore slowest exactly when the backlog was deepest —
-- the condition it exists to report.
--
-- WHY A COUNTER (Option A). Chosen on the record in the ISS-8674 decision
-- comment (Marisol, 2026-09-01), over a per-target LIMITed count (Option B): "never
-- cap or truncate ... maintain an exact per-target queued-command counter
-- atomically with command state transitions". B caps the REPORTED depth, so an
-- operator watching a runaway queue reads the cap instead of the real number,
-- which is the incident this metric exists for.
--
-- That decision asks for more than this migration delivers. It also asks for
-- complete pagination over the fleet rather than a per-tick target cap, and for
-- drift detection beyond the underflow the CHECK in
-- 20260901120050_iss8674_queued_command_backfill refuses. Neither is here; both
-- are called out in the PR rather than quietly folded in, because the
-- pagination half changes what the gauge reports and is a product call.
--
-- WHY A TRIGGER RATHER THAN APPLICATION CODE. The risk attached to that choice
-- is that a denormalized counter which drifts from the rows is worse than the
-- slow query, because it looks authoritative. An application-maintained counter
-- drifts the moment one write path forgets it — there are five today
-- (`desktop-command-store.ts` create/ack/event-ingest/expire and
-- `requeueUndeliveredCommands`), plus the seed reset's `deleteMany`, plus
-- whatever an operator runs by hand against a wedged queue, which during a
-- runaway backlog is a LIKELY action rather than a hypothetical one. Four of
-- those five sites also write outside a transaction, so an application
-- increment would be a second statement that a crash could lose.
--
-- A trigger cannot be forgotten and cannot be half-applied: it fires inside the
-- same transaction as the row write for EVERY writer — Prisma, raw SQL, psql,
-- the seed reset, a cascade delete, a route nobody has written yet — and rolls
-- back with it. Prevention here is structural rather than a convention every
-- future reviewer has to keep enforcing.
--
-- WHY INCREMENTAL AND NOT A RECOMPUTE. A trigger that re-derived
-- `count(*) WHERE status = 'queued'` on each write would be self-healing, but
-- it would move the unbounded aggregate off the five-minute cron and onto every
-- command enqueue — strictly worse than the problem being fixed.
--
-- IF IT EVER DRIFTS ANYWAY. The counter is repairable in one statement, with no
-- downtime and no application change:
--
--   UPDATE "compute_targets" AS t
--   SET "queued_command_count" = COALESCE(b."queued_count", 0)
--   FROM (SELECT ct."id",
--                (SELECT count(*) FROM "desktop_commands" dc
--                 WHERE dc."compute_target_id" = ct."id"
--                   AND dc."status" = 'queued') AS "queued_count"
--         FROM "compute_targets" ct) AS b
--   WHERE t."id" = b."id" AND t."queued_command_count" IS DISTINCT FROM b."queued_count";
--
-- WHY THE BACKFILL IS NOT HERE (whitlockk, review of #6414). Every statement below
-- is a catalog change: `ADD COLUMN … DEFAULT` has been metadata-only since
-- PG11, and CREATE FUNCTION/TRIGGER touch no heap. They return in
-- milliseconds, so the ACCESS EXCLUSIVE lock they take on `compute_targets`
-- (and `desktop_commands`, for the trigger) is held only that long — Prisma
-- wraps each migration FILE in its own transaction, so the lock is fully
-- released the moment this file commits, before the next migration's
-- transaction opens. Folding the data pass in here would hold both tables
-- against every registration, heartbeat and command write for as long as the
-- backfill ran, and the backfill is the same whole-backlog aggregate this
-- ticket exists to get off the hot path. The data pass and the CHECK it makes
-- satisfiable therefore live in 20260901120050_iss8674_queued_command_backfill,
-- which reacquires its own lock only for its own duration.
--
-- WHAT THE SPLIT COSTS, AND WHY IT IS SAFE. Between this migration committing
-- and the backfill migration starting — same deploy, not the same instant —
-- the counter is a DELTA FROM ZERO, not the true depth: every row here
-- defaults to 0, and the trigger below only reflects a write that lands in
-- that gap. A target with a pre-existing backlog reads artificially low, and
-- a target whose backlog partly drains in the gap reads negative — and this
-- file adds NO CHECK, so that negative value is stored rather than refused.
-- No command write fails and no write path errors during the gap; the only
-- thing wrong is the queue-depth GAUGE, an observability signal, until the
-- backfill's absolute correction lands. The gap is bounded by the time
-- between two consecutive migration files applying in one deploy, not by
-- anything backlog-sized.
ALTER TABLE "compute_targets"
  ADD COLUMN "queued_command_count" INTEGER NOT NULL DEFAULT 0;

-- Both the status and the owning target are treated as movable, so a row is
-- removed from whatever bucket it was in and added to whatever bucket it is now
-- in. `compute_target_id` never changes today; assuming so would make this
-- silently wrong the first time it does.
CREATE FUNCTION "sync_compute_target_queued_command_count"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'queued' THEN
      UPDATE "compute_targets"
        SET "queued_command_count" = "queued_command_count" + 1
        WHERE "id" = NEW."compute_target_id";
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'queued' THEN
      UPDATE "compute_targets"
        SET "queued_command_count" = "queued_command_count" - 1
        WHERE "id" = OLD."compute_target_id";
    END IF;
    RETURN NULL;
  END IF;

  -- A move is the one path that writes TWO counter rows, and the statements
  -- below take them in (OLD, NEW) order — so a concurrent A→B and B→A would
  -- take the same pair in opposite orders, and Postgres would break the cycle
  -- by aborting one with 40P01 (davetho, review of #6414). Nothing on a
  -- command write path retries that. Taking both rows up front in ascending id
  -- order gives every mover the same acquisition sequence whichever direction
  -- it is moving, so the cycle cannot form. Deliberately inside the move
  -- branch only: a status-only change touches one counter row and can form no
  -- cycle, and that is the hot path.
  IF NEW."compute_target_id" <> OLD."compute_target_id" THEN
    PERFORM 1
      FROM "compute_targets"
      WHERE "id" IN (OLD."compute_target_id", NEW."compute_target_id")
      ORDER BY "id"
      FOR NO KEY UPDATE;
  END IF;

  IF OLD."status" = 'queued'
     AND (NEW."status" IS DISTINCT FROM 'queued'
          OR NEW."compute_target_id" <> OLD."compute_target_id") THEN
    UPDATE "compute_targets"
      SET "queued_command_count" = "queued_command_count" - 1
      WHERE "id" = OLD."compute_target_id";
  END IF;

  IF NEW."status" = 'queued'
     AND (OLD."status" IS DISTINCT FROM 'queued'
          OR NEW."compute_target_id" <> OLD."compute_target_id") THEN
    UPDATE "compute_targets"
      SET "queued_command_count" = "queued_command_count" + 1
      WHERE "id" = NEW."compute_target_id";
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Narrowed to the two columns that can change the count, so the per-event
-- `last_sequence_acked` writes that stream through `ingestCommandEvent` — by
-- far the most frequent update to this table — do not fire it at all.
CREATE TRIGGER "desktop_commands_queued_count_sync"
AFTER INSERT OR DELETE OR UPDATE OF "status", "compute_target_id"
ON "desktop_commands"
FOR EACH ROW
EXECUTE FUNCTION "sync_compute_target_queued_command_count"();

-- A row trigger never fires on TRUNCATE, so without this one a
-- `TRUNCATE desktop_commands` would leave every counter frozen at its last
-- value — a phantom backlog on every target at once, which the CHECK cannot
-- catch because it only refuses negatives. No code path truncates this table
-- today (the seed reset and every write path use DELETE), but the header above
-- calls an operator clearing a wedged queue by hand a LIKELY action, and
-- TRUNCATE is exactly the hand tool for it. Truncating the commands empties
-- every queue by definition, so the correct counter for every target is 0.
CREATE FUNCTION "reset_compute_target_queued_command_counts"()
RETURNS trigger AS $$
BEGIN
  UPDATE "compute_targets"
    SET "queued_command_count" = 0
    WHERE "queued_command_count" <> 0;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "desktop_commands_queued_count_truncate"
AFTER TRUNCATE
ON "desktop_commands"
FOR EACH STATEMENT
EXECUTE FUNCTION "reset_compute_target_queued_command_counts"();
