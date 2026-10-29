-- Prisma cannot express this canonical JSONB-shape predicate. Keep the
-- immutable classifier installed through application rollback: the CHECK must
-- protect old writers for as long as canonical multi-PR rows can exist.
CREATE OR REPLACE FUNCTION "artifact_links_has_canonical_multi_pr_refs"(refs jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN refs IS NULL OR jsonb_typeof(refs) <> 'array' THEN FALSE
    WHEN jsonb_array_length(refs) <= 1 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(refs) AS entry
      WHERE jsonb_typeof(entry) <> 'object'
        OR jsonb_typeof(entry -> 'repositoryFullName') <> 'string'
        OR length(entry ->> 'repositoryFullName') NOT BETWEEN 1 AND 200
        OR jsonb_typeof(entry -> 'prNumber') <> 'number'
        OR (entry ->> 'prNumber') !~ '^[1-9][0-9]*$'
        OR CASE
          WHEN jsonb_typeof(entry -> 'relationTypes') = 'array' THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(entry -> 'relationTypes') AS relation_type
            WHERE relation_type NOT IN ('CREATED', 'REFERENCED', 'REVIEWED')
          )
          ELSE TRUE
        END
    )
  END
$$;

-- Fail before taking the validating ALTER-table lock when an old writer has
-- already produced a row the guard would reject. Remediation must be reviewed;
-- this migration never guesses which PR identities are authoritative.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "artifact_links"
    WHERE "artifact_links_has_canonical_multi_pr_refs"(metadata -> 'prRefs')
      AND metadata ->> 'linkKind' = 'session_pr'
  ) THEN
    RAISE EXCEPTION 'ISS-5269 preflight: canonical multi-PR rows still use scalar session_pr'
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE "artifact_links"
ADD CONSTRAINT "artifact_links_session_pr_set_kind_check"
CHECK (
  NOT "artifact_links_has_canonical_multi_pr_refs"(metadata -> 'prRefs')
    OR COALESCE(metadata ->> 'linkKind', '') <> 'session_pr'
);
