-- Prisma cannot express concurrent builds. These high-volume tables must remain writable during deployment.
-- CreateIndex
CREATE INDEX CONCURRENTLY "artifact_links_project_facet_cover_idx" ON "artifact_links"("organization_id", "link_type", "source_id", "target_id", "id");

-- CreateIndex
CREATE INDEX CONCURRENTLY "branch_file_changes_totals_cover_idx" ON "branch_file_changes"("branch_artifact_id", "head_sha", "additions", "deletions");
