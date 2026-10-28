-- ISS-7223: record when a command entered the queue, not just when it was created.
--
-- WHAT ASKS FOR IT. The ack-timeout sweep
-- (apps/api/lib/desktop-command-ack-timeout.ts) reports commands that have sat
-- `queued` past their ack deadline. It banded on `created_at`, which is dispatch
-- time. `requeueUndeliveredCommands` returns an accepted/running row to `queued`
-- on reconnect and does NOT touch `created_at`, so a command whose ack DID
-- arrive — it reached `accepted`, which only an ack can do — was reported
-- `timed_out` purely because its dispatch happened to fall inside the band. That
-- is a confidently wrong metric value on the exact axis the ticket exists to
-- name, and the same blind spot silently hid every requeued command whose second
-- delivery really did go unacked, because its `created_at` had already aged past
-- the far edge of the band.
--
-- WHY NULLABLE, AND WHY THE BACKFILL IS SCOPED. Only `status = 'queued'` rows
-- are ever read through this column. `desktop_commands` has no retention sweep —
-- the only deleteMany in the repo is the seed reset — so terminal rows
-- accumulate indefinitely, and a full-table backfill would rewrite unbounded
-- history to populate a value nothing reads. NULL here means "not currently
-- queued", which is honest, rather than a plausible-looking timestamp invented
-- for a row whose queue entry was never recorded.
--
-- The ADD COLUMN deliberately carries NO default, and the default is attached
-- afterwards in a separate statement. That split is what keeps history NULL:
-- `CURRENT_TIMESTAMP` is non-volatile, so `ADD COLUMN ... DEFAULT
-- CURRENT_TIMESTAMP` stores a missing-value that EVERY pre-existing row then
-- reads back — which would hand every terminal row an invented queue-entry time
-- and destroy the "NULL means not currently queued" reading above. A later
-- `ALTER COLUMN ... SET DEFAULT` binds only future inserts. Both statements are
-- catalog-only, so neither rewrites the table.
ALTER TABLE "desktop_commands" ADD COLUMN "queued_at" TIMESTAMP(3);

-- Bounded by the live backlog, not by history: `desktop_commands_queued_by_target_idx`
-- is a partial index over exactly `status = 'queued'`, so this touches the rows
-- currently in the queue and no others. Existing queued rows have never been
-- requeued in a way this column recorded, so `created_at` IS their queue entry.
UPDATE "desktop_commands"
  SET "queued_at" = "created_at"
  WHERE "status" = 'queued' AND "queued_at" IS NULL;

-- Now that history is settled, bind the default for future inserts, matching
-- `@default(now())` on the model. Prisma already sends `queued_at` in its
-- INSERT column list rather than leaving it to the server, so this is not what
-- populates a command dispatched through the store; it is what keeps the
-- database's own declaration equal to the schema's — the CI "Verify Prisma dev
-- drift" job diffs the two — and what gives any writer that is not Prisma
-- (seed, backfill, psql) the same value instead of a NULL the sweep's range
-- predicate would silently never match.
ALTER TABLE "desktop_commands"
  ALTER COLUMN "queued_at" SET DEFAULT CURRENT_TIMESTAMP;
