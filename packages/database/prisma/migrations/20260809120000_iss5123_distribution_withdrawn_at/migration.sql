-- ISS-5123: withdraw a pack from org distribution.
--
-- Purely additive: two nullable columns plus one index. Existing rows keep
-- `withdrawn_at = NULL`, which is exactly "still distributed", so no backfill is
-- required and a rollback to the previous read path (which does not filter on
-- the column) is a no-op.
--
-- Soft-delete rather than a row delete on purpose: `distribution_target_status`
-- is ON DELETE CASCADE from `distributions`, so deleting the row would destroy
-- the record of which machines the pack had reached. Withdrawal leaves
-- already-installed copies in place, so that history is precisely what an admin
-- still needs afterwards.
ALTER TABLE "distributions" ADD COLUMN "withdrawn_at" TIMESTAMP(3);
ALTER TABLE "distributions" ADD COLUMN "withdrawn_by_id" UUID;

ALTER TABLE "distributions"
  ADD CONSTRAINT "distributions_withdrawn_by_id_fkey"
  FOREIGN KEY ("withdrawn_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- No index on `withdrawn_at`. Every live-distribution read is already scoped by
-- `organization_id`, which `distributions_organization_id_idx` covers, and an
-- org holds only a handful of distributions — so the added `withdrawn_at IS
-- NULL` filter is applied to a tiny row set and a composite index would buy
-- nothing measurable. It would, however, cost a separate non-transactional
-- `CREATE INDEX CONCURRENTLY` migration to avoid the table lock. If the table
-- ever grows enough to want one, it can land concurrently on its own.
