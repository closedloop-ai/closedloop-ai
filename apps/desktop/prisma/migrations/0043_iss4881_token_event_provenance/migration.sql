-- ISS-4881: provider-neutral producer provenance/completeness foundation.
-- Nullable columns preserve untouched legacy rows without a retroactive backfill.
ALTER TABLE "token_events" ADD COLUMN "transport_id" TEXT;
ALTER TABLE "token_events" ADD COLUMN "source_identity" TEXT;
ALTER TABLE "token_events" ADD COLUMN "cost_summary" TEXT;

-- Internal transport identity is stable per normalized occurrence and remains
-- separate from provider/source-record evidence.
-- The partial predicate permits every pre-migration NULL legacy row to coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_token_events_session_transport"
  ON "token_events"("session_id", "transport_id")
  WHERE transport_id IS NOT NULL;
