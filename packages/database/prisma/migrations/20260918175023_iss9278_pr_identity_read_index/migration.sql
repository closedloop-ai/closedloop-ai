-- Prisma cannot express concurrent index builds. Keep this as one bare statement
-- so deployment does not block writes or accept an invalid prior index.
-- CreateIndex
CREATE INDEX CONCURRENTLY "pull_request_detail_org_repo_name_number_idx" ON "pull_request_detail"("organization_id", "repository_full_name", "number");
