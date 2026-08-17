-- ISS-4882: retain provider-neutral provenance/completeness and additive cost
-- lanes on cloud token events. All new columns are nullable and there is no
-- backfill; existing numeric estimated costs remain unchanged.
ALTER TABLE "agent_session_token_events"
  ALTER COLUMN "estimated_cost" DROP DEFAULT,
  ALTER COLUMN "estimated_cost" DROP NOT NULL,
  ADD COLUMN "source_identity" JSONB,
  ADD COLUMN "cost_completeness" TEXT,
  ADD COLUMN "cost_completeness_reason" TEXT,
  ADD COLUMN "subscription_equivalent_cost" DECIMAL(14,6),
  ADD COLUMN "api_estimated_cost" DECIMAL(14,6);
