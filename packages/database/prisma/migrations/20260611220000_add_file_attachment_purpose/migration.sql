-- Add a purpose discriminator so inline document images can share the
-- file_attachments table without entering the default context attachment flow.
ALTER TABLE "file_attachments"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'context';

CREATE INDEX "file_attachments_artifact_id_purpose_idx"
  ON "file_attachments"("artifact_id", "purpose");
