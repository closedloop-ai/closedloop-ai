-- Child order belongs to each PRODUCES relationship. Roots retain the existing
-- artifacts.sort_order authority, so this column is nullable for non-hierarchy
-- links and during version skew.
ALTER TABLE "artifact_links"
ADD COLUMN "sort_order" INTEGER;

-- Preserve the current per-parent order when the new reader is enabled. Every
-- PRODUCES edge is ranked, including retained secondary parents, because one
-- child may occupy a different slot under each parent.
WITH ranked AS (
  SELECT
    link."id",
    ((ROW_NUMBER() OVER (
      PARTITION BY link."organization_id", link."source_id"
      ORDER BY link."created_at", link."id"
    ) - 1) * 1000)::INTEGER AS seeded_order
  FROM "artifact_links" link
  WHERE link."link_type" = 'PRODUCES'
)
UPDATE "artifact_links" link
SET "sort_order" = ranked.seeded_order
FROM ranked
WHERE link."id" = ranked."id";
