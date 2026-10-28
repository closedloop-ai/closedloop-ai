CREATE INDEX CONCURRENTLY "artifacts_hierarchy_page_idx"
  ON "artifacts"("organization_id", "project_id", "canonical_parent_id", "hierarchy_rank", "created_at" DESC, "id");
CREATE INDEX CONCURRENTLY "artifacts_hierarchy_type_page_idx"
  ON "artifacts"("organization_id", "project_id", "type", "sort_order", "created_at" DESC, "id");
CREATE INDEX CONCURRENTLY "artifacts_hierarchy_document_category_page_idx"
  ON "artifacts"("organization_id", "project_id", "type", "subtype", "sort_order", "created_at" DESC, "id");
