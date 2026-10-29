-- ISS-8602: which acknowledgement contract the producer that opened a staged
-- chunk sequence speaks, so the cron TTL sweep can tell whether freeing that
-- marker costs the client a re-send or its only copy of the sequence tail.
--
-- DELIBERATELY NO BACKFILL, and no default. Every existing row keeps NULL, and
-- the sweep's predicate is an equality test against 'row_level' — which no NULL
-- satisfies — so every row staged before this column existed is outside the
-- sweep's reach until its session next syncs and re-stages the band. That is the
-- fail-safe: a backfill guessing 'row_level' would hand the sweep exactly the
-- population whose producer band is unknown, which is the population at risk.
-- See apps/api/app/agent-sessions/service/pending-chunk-ack-contract.ts.
--
-- Additive, nullable, no default: a metadata-only ADD COLUMN, no table rewrite.

-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "pending_chunk_ack_contract" TEXT;
