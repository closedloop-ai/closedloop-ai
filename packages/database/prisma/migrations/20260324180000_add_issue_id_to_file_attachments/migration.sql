-- AlterTable: make artifactId nullable, add issueId
ALTER TABLE "file_attachments" ALTER COLUMN "artifact_id" DROP NOT NULL;

ALTER TABLE "file_attachments" ADD COLUMN "issue_id" UUID;

-- CreateIndex
CREATE INDEX "file_attachments_issue_id_idx" ON "file_attachments"("issue_id");
