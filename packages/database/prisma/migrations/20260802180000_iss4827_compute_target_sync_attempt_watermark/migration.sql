-- ISS-4827: per-target ingest ATTEMPT watermark.
--
-- WHY. `/cron/sample-session-ingestion-health` separated a STALLED org from a
-- QUIET one using `max(compute_targets.last_seen_at)` — the DEVICE HEARTBEAT.
-- That signal proves PRESENCE, not an ingest attempt: `last_seen_at` is
-- refreshed by registration, heartbeat, and online-state check-ins on a ~30-90s
-- cadence with no ingest request behind it, while the desktop sync service
-- sends NOTHING when its queues are empty. A developer who left the desktop app
-- open over a long weekend therefore presented a fresh heartbeat next to a
-- 3-day-old ingest watermark and PAGED as an ingestion outage.
--
-- `last_agent_session_sync_attempt_at` is stamped inside the same transaction as
-- an ACCEPTED session batch, INCLUDING the zero-row batches (empty payload /
-- all-foreign-chunk) that ISS-4678 deliberately stopped stamping into
-- `last_agent_session_sync_at`. The pair is then unambiguous:
--
--   attempt fresh + ingest stale  => the fleet is reaching us and its data is
--                                    NOT landing. Genuine stall. Page.
--   attempt stale + ingest stale  => nothing is even trying. Quiet. Do not page.
--
-- NULLABLE + ADDITIVE. `NULL` means "no accepted batch observed since this
-- column existed", which the classifier treats as "not attempting" — the
-- non-paging side, so a version-skewed or pre-backfill row can never invent a
-- page.
--
-- BACKFILL. Seeded from `last_agent_session_sync_at` where present. That is a
-- truthful LOWER BOUND, never a fabricated timestamp: a row whose data landed at
-- T demonstrably had an accepted batch at T. Without it every row would read
-- "never attempted" until its next batch, blanking the stall detector for the
-- whole migration window. The write touches only rows that have ingested at
-- least once (the `compute_targets` fleet, not a hot event table), and it is
-- purely additive — no column is dropped, narrowed, or rewritten.

-- AlterTable
ALTER TABLE "compute_targets" ADD COLUMN     "last_agent_session_sync_attempt_at" TIMESTAMP(3);

-- Backfill: last landed ingest is a proven lower bound on the last accepted batch.
UPDATE "compute_targets" SET "last_agent_session_sync_attempt_at" = "last_agent_session_sync_at" WHERE "last_agent_session_sync_at" IS NOT NULL;
