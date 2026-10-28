-- ISS-9618: the two columns the cloud routine execution engine needs.
--
-- `routine_runs.loop_id` is the link that makes the Loop the single source of
-- truth for a cloud routine's execution and the run row a PROJECTION of it. The
-- dispatch sweep writes the receipt with the id of the Loop it launched; the
-- settle sweep reads that Loop's terminal status back onto the row. Without it a
-- dispatched run would sit at RUNNING forever. Nullable because a desktop-origin
-- (synced) run has no cloud Loop, and deliberately NOT a foreign key: the settle
-- pass must handle an unreadable Loop regardless, so the constraint would add a
-- lock on `loops` to buy nothing it uses.
--
-- `routines.cloud_dispatch_failures` is the CONSECUTIVE dispatch-failure counter
-- the bounded retry ladder is computed from, reset to 0 on the first success.
-- Defaulted so every existing row starts on rung zero.
--
-- Both are additive and defaulted/nullable, so an API build that predates them
-- keeps reading and writing these tables unchanged.
ALTER TABLE "routine_runs" ADD COLUMN "loop_id" UUID;

ALTER TABLE "routines" ADD COLUMN "cloud_dispatch_failures" INTEGER NOT NULL DEFAULT 0;
