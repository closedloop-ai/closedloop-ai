-- PLN-602 Migration B: Drop the legacy target_repo / target_branch columns
-- from document_detail. The data was migrated into repository_snapshot in
-- 20260518151836_add_repository_snapshot. All callers have been switched to
-- read from the snapshot, so the legacy columns are now safe to remove.

ALTER TABLE "document_detail" DROP COLUMN "target_repo";
ALTER TABLE "document_detail" DROP COLUMN "target_branch";
