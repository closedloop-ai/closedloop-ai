-- Main temporarily recorded reparenting choices under projectHierarchy.
-- Translate those booleans into the canonical placement reader namespace.
WITH translated AS (
  SELECT
    link."id",
    CASE
      WHEN jsonb_typeof(link."metadata" #> '{projectHierarchy,preferred}') = 'boolean'
        AND link."metadata" #> '{hierarchy,canonical}' IS NULL
        THEN link."metadata" #> '{projectHierarchy,preferred}'
    END AS canonical,
    CASE
      WHEN jsonb_typeof(link."metadata" #> '{projectHierarchy,excluded}') = 'boolean'
        AND link."metadata" #> '{hierarchy,suppressed}' IS NULL
        THEN link."metadata" #> '{projectHierarchy,excluded}'
    END AS suppressed
  FROM "artifact_links" link
  WHERE link."link_type" = 'PRODUCES'
    AND (
      jsonb_typeof(link."metadata" #> '{projectHierarchy,preferred}') = 'boolean'
      OR jsonb_typeof(link."metadata" #> '{projectHierarchy,excluded}') = 'boolean'
    )
)
UPDATE "artifact_links" link
SET "metadata" = jsonb_set(
  link."metadata",
  '{hierarchy}',
  CASE
    WHEN jsonb_typeof(link."metadata" -> 'hierarchy') = 'object'
      THEN link."metadata" -> 'hierarchy'
    ELSE '{}'::jsonb
  END || jsonb_strip_nulls(
    jsonb_build_object(
      'canonical', translated.canonical,
      'suppressed', translated.suppressed
    )
  ),
  true
)
FROM translated
WHERE link."id" = translated."id";
