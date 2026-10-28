-- ISS-12781: hold a part's redacted wire items on its ledger row until the
-- generation completes, so activation rewrites only changed invocation rows.
-- `staged_invocation_ids` holds the same part's projected ids, so the
-- cross-part id check does not read the payload.
-- ADDITIVE: two nullable columns. No row is read, written or deleted.

-- AlterTable
ALTER TABLE "agent_component_invocation_parts" ADD COLUMN     "staged_invocation_ids" JSONB,
ADD COLUMN     "staged_items" JSONB;
