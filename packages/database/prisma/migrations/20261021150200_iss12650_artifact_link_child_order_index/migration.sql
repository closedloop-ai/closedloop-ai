-- NON-TRANSACTIONAL BY DESIGN. Placement reads one parent's PRODUCES links by
-- organization and rank; CONCURRENTLY avoids a table-wide writer lock on the
-- existing artifact_links table. Keep this migration to the bare concurrent
-- statement so Prisma never needs to wrap it in a transaction.
CREATE INDEX CONCURRENTLY "artifact_links_parent_rank_idx"
ON "artifact_links"("organization_id", "source_id", "link_type", "sort_order", "target_id");
