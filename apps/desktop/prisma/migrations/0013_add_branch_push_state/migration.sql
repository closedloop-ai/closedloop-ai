-- FEA-2531: branch push state on the canonical artifacts row.
-- first_pushed_at is set-once (earliest push evidence wins); push_source records
-- which system produced that evidence ('session' now; BranchHeadShaSource webhook
-- spellings reserved for future cloud ingestion).
ALTER TABLE "artifacts" ADD COLUMN "first_pushed_at" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "push_source" TEXT;
