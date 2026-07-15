-- Supports Branches list visibility for remote-head-only branch artifacts.
-- Prisma cannot express this partial index; keep the schema comment in sync.
CREATE INDEX "branch_detail_remote_head_evidence_idx"
  ON "branch_detail"("head_sha_source", "last_activity_at" DESC, "artifact_id")
  WHERE "head_sha" IS NOT NULL
    AND "deleted_at" IS NULL;
