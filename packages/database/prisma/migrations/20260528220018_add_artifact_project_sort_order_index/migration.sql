-- CreateIndex
CREATE INDEX "artifacts_organization_id_project_id_sort_order_idx" ON "artifacts"("organization_id", "project_id", "sort_order");
