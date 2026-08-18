-- FEA-3490: persist the org-scoped @-mention user-ID list on desktop-local
-- trace comments so a mention picked offline round-trips through the local
-- store and syncs to the cloud API instead of silently disappearing. Additive
-- and back-compatible: existing rows default to an empty list (no mentions).
ALTER TABLE "trace_comments"
  ADD COLUMN "mentions" JSONB NOT NULL DEFAULT [];
