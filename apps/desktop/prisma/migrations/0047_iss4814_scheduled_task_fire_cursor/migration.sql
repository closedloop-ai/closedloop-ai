-- ISS-4814: durable fire cursor for one-time (recurring=false) scheduled tasks.
--
-- The daemon used to retire a one-time task by DISABLING it after the run
-- reached its terminal bookkeeping, leaving a crash window: a kill between the
-- launch and that bookkeeping left the task enabled, and `last_run_at` only
-- suppresses the CURRENT cron slot, so a restarted daemon re-fired it at the
-- next matching slot. `fired_at` is stamped in the same statement as the launch
-- stamp, so the fire is durably spent the moment the run starts.
--
-- Nullable, no default: NULL means "not yet fired".
ALTER TABLE "scheduled_tasks" ADD COLUMN "fired_at" TEXT;

-- Backfill the cursor for one-time tasks that EVIDENTLY already fired, so the
-- upgraded daemon does not re-launch the exact population this issue exists to
-- protect. Adding the column with a blanket NULL would assert "never fired"
-- about a crash survivor: an older build could die after persisting
-- `last_run_at` on an enabled one-time task but before the disable that retired
-- it, and that row (recurring = 0, enabled = 1, last_run_at NOT NULL) is
-- precisely the re-fire this migration ships to prevent.
--
-- `last_run_at IS NOT NULL` is the safe discriminator, and it is exact rather
-- than heuristic: `last_run_at` is only ever written by `startRun` (the launch
-- stamp) or `advanceLastRun` (a slot a confirmed native/cloud owner ran), so a
-- non-null value on a one-time task means its single slot is already accounted
-- for, and a genuinely never-fired task has no way to carry one. The cursor is
-- backfilled to `last_run_at` — the instant of that fire — which is exactly what
-- `startRun` would have stamped. A never-fired task keeps a NULL `last_run_at`,
-- so it stays NULL here and fires normally.
--
-- `enabled` is deliberately NOT in the predicate: a one-time task the old build
-- DID retire (enabled = 0) is equally spent, and stamping it too keeps the two
-- retirement shapes from disagreeing after an upgrade. `recurring` is a SQLite
-- INTEGER boolean, so 0 = one-time; a recurring task tracks its cadence through
-- `last_run_at` alone and must never carry a cursor.
UPDATE "scheduled_tasks"
   SET "fired_at" = "last_run_at"
 WHERE "recurring" = 0
   AND "last_run_at" IS NOT NULL
   AND "fired_at" IS NULL;
