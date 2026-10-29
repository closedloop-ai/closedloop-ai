-- The landed hierarchy scaffold temporarily wrote child order into link
-- metadata. Move every valid integer rank to the canonical relationship
-- column before that reader is removed. Invalid metadata keeps the stable
-- link-creation-order rank seeded by the preceding ISS-12650 migration.
WITH metadata_ranks AS (
  SELECT
    link."id",
    (link."metadata" #>> '{projectHierarchy,sortOrder}')::INTEGER AS sort_order
  FROM "artifact_links" link
  WHERE link."link_type" = 'PRODUCES'
    AND jsonb_typeof(link."metadata" #> '{projectHierarchy,sortOrder}') = 'number'
    AND (link."metadata" #>> '{projectHierarchy,sortOrder}')::NUMERIC =
      trunc((link."metadata" #>> '{projectHierarchy,sortOrder}')::NUMERIC)
    AND (link."metadata" #>> '{projectHierarchy,sortOrder}')::NUMERIC
      BETWEEN -2147483648 AND 2147483647
)
UPDATE "artifact_links" link
SET "sort_order" = metadata_ranks.sort_order
FROM metadata_ranks
WHERE link."id" = metadata_ranks."id"
  AND link."sort_order" IS DISTINCT FROM metadata_ranks.sort_order;
