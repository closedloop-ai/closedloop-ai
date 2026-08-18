-- FEA-4171: persist a desktop-local trace comment's classification so a comment
-- flagged as a parsing/data bug offline round-trips through the local store and
-- syncs its `kind` to the cloud API, where the golden-dataset CANDIDATE pipeline
-- surfaces it. Additive and back-compatible: existing rows and every ordinary
-- comment default to 'comment'. Metadata-only op.

-- AlterTable
ALTER TABLE "trace_comments"
  ADD COLUMN "comment_kind" TEXT NOT NULL DEFAULT 'comment';
