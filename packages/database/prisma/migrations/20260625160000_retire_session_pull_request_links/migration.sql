-- FEA-1900: Retire SessionPullRequestLink — consolidate into ArtifactLink
--
-- Phase 1: Backfill artifact_links from session_pull_request_links
-- Phase 2: Drop old table and enums

-- ---------------------------------------------------------------------------
-- Phase 1a: Backfill rows WITH pull_request_detail_id (resolved FK)
-- Groups by (session_artifact, branch_artifact) to aggregate CREATED+REFERENCED
-- relationTypes into a single ArtifactLink row with a JSON array.
-- ---------------------------------------------------------------------------
INSERT INTO artifact_links (id, organization_id, source_id, target_id, link_type, metadata, created_at)
SELECT
  gen_random_uuid(),
  spl.organization_id,
  spl.session_artifact_id,
  prd.branch_artifact_id,
  'RELATES_TO',
  jsonb_build_object(
    'linkKind', 'session_pr',
    'relationTypes', (
      SELECT jsonb_agg(DISTINCT sub.relation_type::text ORDER BY sub.relation_type::text)
      FROM session_pull_request_links sub
      WHERE sub.session_artifact_id = spl.session_artifact_id
        AND sub.pull_request_detail_id IS NOT NULL
        AND (
          SELECT prd2.branch_artifact_id
          FROM pull_request_detail prd2
          WHERE prd2.id = sub.pull_request_detail_id
        ) = prd.branch_artifact_id
    ),
    'source', 'DETERMINISTIC',
    'confidence', MAX(spl.confidence),
    'extractorVersion', MAX(spl.extractor_version),
    'repositoryFullName', MIN(spl.repository_full_name),
    'prNumber', MIN(spl.pr_number),
    'prUrl', MIN(spl.pr_url)
  ),
  MIN(spl.created_at)
FROM session_pull_request_links spl
JOIN pull_request_detail prd ON prd.id = spl.pull_request_detail_id
GROUP BY spl.organization_id, spl.session_artifact_id, prd.branch_artifact_id
ON CONFLICT (source_id, target_id, link_type) DO UPDATE SET
  metadata = EXCLUDED.metadata;

-- ---------------------------------------------------------------------------
-- Phase 1b: Backfill rows WITHOUT pull_request_detail_id (fallback resolution)
-- Resolves via organization → installation → repository → pull_request_detail.
-- Rows that still can't resolve are accepted losses (best-effort failures).
-- ---------------------------------------------------------------------------
INSERT INTO artifact_links (id, organization_id, source_id, target_id, link_type, metadata, created_at)
SELECT
  gen_random_uuid(),
  spl.organization_id,
  spl.session_artifact_id,
  prd.branch_artifact_id,
  'RELATES_TO',
  jsonb_build_object(
    'linkKind', 'session_pr',
    'relationTypes', jsonb_build_array(spl.relation_type::text),
    'source', 'DETERMINISTIC',
    'confidence', spl.confidence,
    'extractorVersion', spl.extractor_version,
    'repositoryFullName', spl.repository_full_name,
    'prNumber', spl.pr_number,
    'prUrl', spl.pr_url
  ),
  spl.created_at
FROM session_pull_request_links spl
JOIN github_installations gi ON gi.organization_id = spl.organization_id
JOIN github_installation_repositories gir
  ON gir.installation_id = gi.id
  AND gir.full_name = spl.repository_full_name
JOIN pull_request_detail prd
  ON prd.repository_id = gir.id
  AND prd.number = spl.pr_number
WHERE spl.pull_request_detail_id IS NULL
ON CONFLICT (source_id, target_id, link_type) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Phase 1c: Preserve unresolvable legacy rows as session metadata
-- Rows that neither Phase 1a nor Phase 1b could migrate (missing installation,
-- missing repo, missing PR detail) are stored in session_detail.metadata as
-- _unresolvedPrRefs so no data is silently dropped.
-- ---------------------------------------------------------------------------
UPDATE session_detail sd
SET metadata = jsonb_set(
  COALESCE(sd.metadata, '{}'::jsonb),
  '{_unresolvedPrRefs}',
  COALESCE(
    (SELECT jsonb_agg(DISTINCT jsonb_build_object(
      'repositoryFullName', spl.repository_full_name,
      'prNumber', spl.pr_number
    ))
    FROM session_pull_request_links spl
    WHERE spl.session_artifact_id = sd.artifact_id
      AND NOT EXISTS (
        SELECT 1 FROM artifact_links al
        WHERE al.source_id = spl.session_artifact_id
          AND al.link_type = 'RELATES_TO'
          AND al.metadata->>'linkKind' = 'session_pr'
          AND (al.metadata->>'repositoryFullName') = spl.repository_full_name
          AND (al.metadata->>'prNumber')::int = spl.pr_number
      )),
    '[]'::jsonb
  )
)
WHERE EXISTS (
  SELECT 1 FROM session_pull_request_links spl2
  WHERE spl2.session_artifact_id = sd.artifact_id
    AND NOT EXISTS (
      SELECT 1 FROM artifact_links al2
      WHERE al2.source_id = spl2.session_artifact_id
        AND al2.link_type = 'RELATES_TO'
        AND al2.metadata->>'linkKind' = 'session_pr'
        AND (al2.metadata->>'repositoryFullName') = spl2.repository_full_name
        AND (al2.metadata->>'prNumber')::int = spl2.pr_number
    )
);

-- ---------------------------------------------------------------------------
-- Phase 2: Drop old table and enums
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS session_pull_request_links;
DROP TYPE IF EXISTS "SessionPrRelationType";
DROP TYPE IF EXISTS "SessionPrLinkSource";
