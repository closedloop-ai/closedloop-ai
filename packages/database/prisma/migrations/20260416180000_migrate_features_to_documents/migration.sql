-- Migrate existing Features (issues table) into Documents (artifacts table) as type=FEATURE.
-- Feature UUIDs are preserved so existing entity_links, comment_threads, and attachments
-- keep resolving against the same IDs — they only change entity_type.
--
-- This is a data-only migration. The `issues` table is left intact and will be dropped
-- in a later schema-cleanup migration once all consumers are switched off Feature.

-- 1. Copy features into artifacts as type=FEATURE, preserving IDs and slugs.
INSERT INTO artifacts (
  id, organization_id, workstream_id, project_id, type, title, slug,
  status, priority, assignee_id, created_by_id, latest_version,
  created_at, updated_at
)
SELECT
  i.id,
  i.organization_id,
  i.workstream_id,
  i.project_id,
  'FEATURE'::"ArtifactType",
  i.title,
  i.slug,
  i.status::text::"ArtifactStatus",
  i.priority,
  i.assignee_id,
  i.created_by_id,
  1,
  i.created_at,
  i.updated_at
FROM issues i
ON CONFLICT (id) DO NOTHING;

-- 2. Create version 1 for each migrated feature; description becomes the initial content.
INSERT INTO artifact_versions (
  id, artifact_id, version, content, created_by_id, created_at
)
SELECT
  gen_random_uuid(),
  i.id,
  1,
  COALESCE(i.description, ''),
  i.created_by_id,
  i.created_at
FROM issues i
WHERE NOT EXISTS (
  SELECT 1 FROM artifact_versions av
  WHERE av.artifact_id = i.id AND av.version = 1
);

-- 3. Update entity_links: ISSUE -> ARTIFACT.
UPDATE entity_links SET source_type = 'ARTIFACT' WHERE source_type = 'ISSUE';
UPDATE entity_links SET target_type = 'ARTIFACT' WHERE target_type = 'ISSUE';

-- 4. Update comment_threads: ISSUE -> ARTIFACT.
UPDATE comment_threads SET entity_type = 'ARTIFACT' WHERE entity_type = 'ISSUE';

-- 5. Move file_attachments.issue_id -> artifact_id for rows that attached to a feature.
UPDATE file_attachments
SET artifact_id = issue_id,
    issue_id = NULL
WHERE issue_id IS NOT NULL;

-- 6. Update custom_field_settings: ISSUE -> ARTIFACT (DB values for FEATURE/DOCUMENT).
UPDATE custom_field_settings SET entity_type = 'ARTIFACT' WHERE entity_type = 'ISSUE';

-- 7. Update custom_field_values: ISSUE -> ARTIFACT.
UPDATE custom_field_values SET entity_type = 'ARTIFACT' WHERE entity_type = 'ISSUE';

-- 8. Replace ISSUE in custom_fields.entity_types array with ARTIFACT.
UPDATE custom_fields
SET entity_types = (
  SELECT ARRAY_AGG(DISTINCT
    CASE WHEN et::text = 'ISSUE' THEN 'ARTIFACT'::"CustomFieldEntityType" ELSE et END
  )
  FROM UNNEST(entity_types) AS et
)
WHERE 'ISSUE' = ANY(entity_types::text[]);
