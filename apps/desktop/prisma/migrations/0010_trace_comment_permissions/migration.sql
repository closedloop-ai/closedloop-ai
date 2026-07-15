-- Preserve the API's authorization result for cloud-backed trace comments in
-- the desktop-local cache. Local-only rows remain editable offline.
ALTER TABLE "trace_comments"
  ADD COLUMN "can_edit" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "trace_comments"
  ADD COLUMN "can_delete" BOOLEAN NOT NULL DEFAULT false;

UPDATE "trace_comments"
SET
  "can_edit" = true,
  "can_delete" = true
WHERE "cloud_comment_id" IS NULL OR "author_id" = 'desktop-local';
