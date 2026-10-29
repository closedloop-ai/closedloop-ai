-- ISS-9617 (FEA-4358b): the desktop→cloud Routine sync lane's durable state.
--
-- TWO tables, for the reason the invocation lane already has two. The outbox
-- holds the OBLIGATION and its rows are deleted on a verified ack (invariant 1,
-- `apps/desktop/src/main/sync/AGENTS.md`), so it cannot also hold a high-water
-- mark; `routine_sync_cursors` holds what the cloud has already confirmed and
-- outlives the ephemeral outbox row. Same split, same reason, as
-- `agent_component_invocation_sync_outbox` / `agent_component_invocation_sync_cursors`.
--
-- Both are keyed `(source_key, source_id)`. `source_id` is the crewd
-- `ScheduledTask.id` — an arbitrary string, not a UUID — and is the same identity
-- the cloud upserts on, so a row here and the cloud row it drives cannot
-- disagree about which task they describe.
--
-- `source_key` scoping is not optional: it is what stops one account/machine
-- from draining another's queue (invariant 2), and the ready index leads with it
-- for that reason.
--
-- No FK to `scheduled_tasks`, deliberately — a row must be able to outlive a
-- locally-deleted task, because that straggler is exactly what the outbox exists
-- to record (invariant 8).

-- CreateTable
CREATE TABLE IF NOT EXISTS "routine_sync_outbox" (
    "source_key" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TEXT,
    "last_error" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "routine_sync_outbox_pkey"
      PRIMARY KEY ("source_key", "source_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "routine_sync_cursors" (
    "source_key" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "synced_source_updated_at" TEXT,
    "runs_cursor" TEXT,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "routine_sync_cursors_pkey"
      PRIMARY KEY ("source_key", "source_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_routine_sync_outbox_ready"
  ON "routine_sync_outbox"("source_key", "status", "next_attempt_at");
