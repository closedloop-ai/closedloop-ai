-- ISS-8897: a presence-only clock, distinct from `last_seen_at`.
--
-- `last_seen_at` is stamped by every desktop-originated check-in on every
-- transport — registration, `POST /compute-targets/:id/heartbeat`, the results
-- ingest route, the direct Socket.IO server's 30s timer, and the SSE stream's
-- online mark. None of those drives the presence-triggered command drain, which
-- runs only off a relay `presence` frame. The idle drain read `last_seen_at` as
-- "the presence trigger owns this target", so a desktop checking in on any
-- other transport looked covered while nothing was draining its backlog.
--
-- This column means exactly one thing: the last relay `presence` frame observed
-- for this target. Only `handlePresence` writes it.
ALTER TABLE "compute_targets" ADD COLUMN "presence_at" TIMESTAMP(3);

-- Seeded from `last_seen_at` rather than left NULL. NULL is the honest value
-- for a row created after this migration, and the drain reads it as "the
-- presence trigger has never covered this target" — correct there. Applying
-- that to the EXISTING fleet would instead date every target's presence from
-- its `created_at`, pushing weeks-old rows past the 24h give-up horizon in one
-- deploy and abandoning exactly the recently-disconnected targets the drain
-- exists to serve, until each one reconnected. `last_seen_at` is a superset of
-- presence, so this seed is an upper bound on the truth — never a claim of
-- presence that could not have happened — and it decays to the real value on
-- the connected fleet's next heartbeat (30s).
UPDATE "compute_targets" SET "presence_at" = "last_seen_at";

-- ISS-8896: the cross-instance lease for a queued-command release.
--
-- `releaseQueuedCommands` reads the target's declared ceiling, counts what is
-- in flight, and dispatches the difference. That read-modify-write was guarded
-- only by a process-local map, so N API instances each held their own gate and
-- each dispatched a full `ceiling - inFlight` against the same ceiling. NULL is
-- "no release in progress"; a value in the past is an expired lease, which is
-- what keeps a crashed instance from holding a target forever.
ALTER TABLE "compute_targets" ADD COLUMN "command_drain_lease_until" TIMESTAMP(3);
