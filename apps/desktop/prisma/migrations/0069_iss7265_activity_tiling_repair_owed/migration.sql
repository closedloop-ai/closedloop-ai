-- ISS-7265 AC3: the durable repair obligation a stripped activity tiling leaves
-- behind, so the strip is a DEFERRAL rather than a discard.
--
-- The ISS-4578 bounded fallback ships an oversized session WITHOUT its activity
-- tiling when the server cannot merge a multi-part tiling. PR #5456 and the
-- first half of this ticket made that visible on the wire, in telemetry and on
-- the cloud row. None of that changes where the data went: a stripped delivery
-- is ACKED like any other, which clears the outbox and dequeues the session,
-- and nothing re-selects it — selection walks `sessions.updated_at`, not "the
-- delivery was incomplete". The tiling was therefore lost for good on that
-- cloud, which is the judgment AC3 asks to be made rather than inherited.
--
-- The judgment made here: stripping stays (refusing would dead-letter the whole
-- session and lose its events, agents, metadata and token events too), but a
-- strip now RECORDS A DEBT, and the debt is settled by re-delivering the tiling
-- once the constraint that forced the strip is gone.
--
-- One row per session, PK on `session_id`, so the record is naturally idempotent
-- under `ON CONFLICT DO NOTHING` and every access path is a primary-key seek.
-- `ON DELETE CASCADE` matches every other session-keyed marker table: a purged
-- session must not leave behind a debt for a row that no longer exists.
--
-- `requeued_at` is the self-terminating half, and is why `ON CONFLICT DO NOTHING`
-- rather than an upsert: NULL means "owed, never asked", a timestamp means "this
-- device has already asked the sync lane to re-deliver". The repair pass only
-- ever selects the NULL rows, so a session that strips AGAIN on its re-delivery
-- cannot re-open its own request and drive an endless `updated_at` bump — the
-- sync-cursor churn `billing-mode-heal.ts` documents and refuses. A debt is
-- re-armable only through the honest route: the row is DELETED when a delivery
-- of that session is confirmed with its tiling intact, so a later strip records
-- a fresh row with `requeued_at` NULL again.
--
-- A row here means "this device owes the cloud this session's tiling". It is
-- never an acknowledgement and must never be read as one; the absence of a row
-- is not evidence the tiling arrived either, only that none is recorded owed.
CREATE TABLE IF NOT EXISTS "activity_tiling_repair_owed" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "recorded_at" TEXT NOT NULL,
    "requeued_at" TEXT,
    CONSTRAINT "activity_tiling_repair_owed_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- NO index beyond the primary key, deliberately. The repair pass's discovery
-- predicate is `requeued_at IS NULL`, which a partial index would serve — but
-- Prisma cannot express a filtered index, so one here would diverge from
-- `schema.prisma` and fail `prisma-migrations-agreement.test.ts`. It would also
-- buy nothing: the table holds one row per session whose tiling this device
-- still owes, which is empty on every device whose server merges multi-part
-- tilings, and the settle path probes it through the primary key.
