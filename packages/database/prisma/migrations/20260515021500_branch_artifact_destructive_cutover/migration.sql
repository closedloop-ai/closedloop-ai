-- PLN-587 Migration B: destructive branch artifact cutover.

UPDATE "pull_request_detail"
SET "id" = gen_random_uuid()
WHERE "id" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "pull_request_detail"
    WHERE "id" IS NULL
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: pull_request_detail.id backfill left null rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifacts" a
    LEFT JOIN "pull_request_detail" pr ON pr."artifact_id" = a."id"
    WHERE a."type" = 'PULL_REQUEST'
      AND pr."artifact_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: PULL_REQUEST artifact without PullRequestDetail';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifacts" a
    JOIN "pull_request_detail" pr ON pr."artifact_id" = a."id"
    WHERE a."type" = 'PULL_REQUEST'
      AND (pr."repository_id" IS NULL OR pr."head_branch" IS NULL OR pr."head_branch" = '')
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: legacy PR detail missing repository/head branch';
  END IF;
END $$;

CREATE TEMP TABLE "_pln587_pr_branch_map" ON COMMIT DROP AS
WITH pr_rows AS (
  SELECT
    pr."id" AS "pull_request_detail_id",
    pr."artifact_id" AS "pull_request_artifact_id",
    pr."repository_id",
    pr."head_branch",
    pr."base_branch",
    pr."head_sha",
    pr."checks_status",
    pr."pr_state",
    pr."title",
    pr."html_url",
    pr."number",
    a."name" AS "artifact_name",
    a."external_url" AS "artifact_external_url",
    a."status" AS "artifact_status",
    a."updated_at" AS "artifact_updated_at"
  FROM "pull_request_detail" pr
  JOIN "artifacts" a ON a."id" = pr."artifact_id"
  WHERE a."type" = 'PULL_REQUEST'
),
winners AS (
  SELECT
    pr."repository_id",
    pr."head_branch",
    COALESCE(
      (
        SELECT bd."artifact_id"
        FROM "branch_detail" bd
        WHERE bd."repository_id" = pr."repository_id"
          AND bd."branch_name" = pr."head_branch"
        ORDER BY bd."created_at" ASC, bd."artifact_id" ASC
        LIMIT 1
      ),
      (
        SELECT pr2."pull_request_artifact_id"
        FROM pr_rows pr2
        WHERE pr2."repository_id" = pr."repository_id"
          AND pr2."head_branch" = pr."head_branch"
        ORDER BY pr2."pull_request_artifact_id"::text ASC
        LIMIT 1
      )
    ) AS "branch_artifact_id"
  FROM pr_rows pr
  GROUP BY pr."repository_id", pr."head_branch"
)
SELECT pr.*, winners."branch_artifact_id"
FROM pr_rows pr
JOIN winners
  ON winners."repository_id" = pr."repository_id"
 AND winners."head_branch" = pr."head_branch";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_pln587_pr_branch_map"
    GROUP BY "pull_request_detail_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: duplicate PR-detail mapping rows';
  END IF;

  IF EXISTS (
    WITH remapped AS (
      SELECT
        al."id",
        COALESCE(src."branch_artifact_id", al."source_id") AS "source_id",
        COALESCE(tgt."branch_artifact_id", al."target_id") AS "target_id",
        al."link_type"
      FROM "artifact_links" al
      LEFT JOIN "_pln587_pr_branch_map" src
        ON src."pull_request_artifact_id" = al."source_id"
      LEFT JOIN "_pln587_pr_branch_map" tgt
        ON tgt."pull_request_artifact_id" = al."target_id"
    )
    SELECT 1
    FROM remapped
    GROUP BY "source_id", "target_id", "link_type"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: artifact_links would collide after branch reparenting';
  END IF;

  IF EXISTS (
    WITH remapped AS (
      SELECT
        ar."id",
        COALESCE(m."branch_artifact_id", ar."artifact_id") AS "artifact_id",
        ar."user_id",
        ar."organization_id"
      FROM "artifact_ratings" ar
      LEFT JOIN "_pln587_pr_branch_map" m
        ON m."pull_request_artifact_id" = ar."artifact_id"
    )
    SELECT 1
    FROM remapped
    GROUP BY "artifact_id", "user_id", "organization_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: artifact_ratings would collide after branch reparenting';
  END IF;

  IF EXISTS (
    WITH remapped AS (
      SELECT
        ae."id",
        COALESCE(m."branch_artifact_id", ae."artifact_id") AS "artifact_id",
        ae."report_id"
      FROM "artifact_evaluations" ae
      LEFT JOIN "_pln587_pr_branch_map" m
        ON m."pull_request_artifact_id" = ae."artifact_id"
    )
    SELECT 1
    FROM remapped
    GROUP BY "artifact_id", "report_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: artifact_evaluations would collide after branch reparenting';
  END IF;

  IF EXISTS (
    WITH remapped AS (
      SELECT
        l."id",
        COALESCE(m."branch_artifact_id", l."artifact_id") AS "artifact_id",
        l."command",
        l."artifact_version"
      FROM "loops" l
      LEFT JOIN "_pln587_pr_branch_map" m
        ON m."pull_request_artifact_id" = l."artifact_id"
      WHERE l."artifact_id" IS NOT NULL
        AND l."artifact_version" IS NOT NULL
        AND l."status" IN ('PENDING', 'CLAIMED', 'RUNNING')
    )
    SELECT 1
    FROM remapped
    GROUP BY "artifact_id", "command", "artifact_version"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: active loops would collide after branch reparenting';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _pln587_encode_uri_component(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result text := '';
  index integer;
  byte_index integer;
  char_value text;
  encoded bytea;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;

  FOR index IN 1..char_length(value) LOOP
    char_value := substr(value, index, 1);
    IF char_value ~ '^[A-Za-z0-9_.!~*''()-]$' THEN
      result := result || char_value;
    ELSE
      encoded := convert_to(char_value, 'UTF8');
      FOR byte_index IN 0..length(encoded) - 1 LOOP
        result := result || '%' || upper(lpad(to_hex(get_byte(encoded, byte_index)), 2, '0'));
      END LOOP;
    END IF;
  END LOOP;

  RETURN result;
END;
$$;

UPDATE "artifacts" a
SET
  "type" = 'BRANCH',
  "name" = m."head_branch",
  "external_url" = concat(
    'https://github.com/',
    repo."full_name",
    '/tree/',
    _pln587_encode_uri_component(m."head_branch")
  ),
  "status" = CASE
    WHEN m."pr_state" = 'MERGED' THEN 'MERGED'
    WHEN m."pr_state" = 'CLOSED' THEN 'CLOSED'
    ELSE 'OPEN'
  END
FROM (
  SELECT DISTINCT ON ("branch_artifact_id")
    "branch_artifact_id",
    "repository_id",
    "head_branch",
    "pr_state",
    "artifact_updated_at"
  FROM "_pln587_pr_branch_map"
  ORDER BY
    "branch_artifact_id",
    ("pr_state" = 'OPEN') DESC,
    "artifact_updated_at" DESC,
    "pull_request_artifact_id" ASC
) m
JOIN "github_installation_repositories" repo ON repo."id" = m."repository_id"
WHERE a."id" = m."branch_artifact_id";

INSERT INTO "branch_detail" (
  "artifact_id",
  "repository_id",
  "branch_name",
  "base_branch",
  "base_branch_source",
  "head_sha",
  "head_sha_source",
  "head_sha_observed_at",
  "last_push_before_sha",
  "checks_status",
  "file_cache_status",
  "sync_status",
  "created_at",
  "updated_at"
)
SELECT DISTINCT ON (m."branch_artifact_id")
  m."branch_artifact_id",
  m."repository_id",
  m."head_branch",
  m."base_branch",
  'migration_pr_base',
  m."head_sha",
  'migration_pr_head',
  now(),
  NULL,
  m."checks_status",
  'absent',
  'idle',
  now(),
  now()
FROM "_pln587_pr_branch_map" m
ORDER BY
  m."branch_artifact_id",
  (m."pr_state" = 'OPEN') DESC,
  m."artifact_updated_at" DESC,
  m."pull_request_artifact_id" ASC
ON CONFLICT ("artifact_id") DO UPDATE
SET
  "repository_id" = EXCLUDED."repository_id",
  "branch_name" = EXCLUDED."branch_name",
  "base_branch" = COALESCE("branch_detail"."base_branch", EXCLUDED."base_branch"),
  "base_branch_source" = COALESCE("branch_detail"."base_branch_source", EXCLUDED."base_branch_source"),
  "head_sha" = COALESCE("branch_detail"."head_sha", EXCLUDED."head_sha"),
  "head_sha_source" = COALESCE("branch_detail"."head_sha_source", EXCLUDED."head_sha_source"),
  "head_sha_observed_at" = COALESCE("branch_detail"."head_sha_observed_at", EXCLUDED."head_sha_observed_at"),
  "checks_status" = EXCLUDED."checks_status";

UPDATE "pull_request_detail" pr
SET
  "branch_artifact_id" = m."branch_artifact_id",
  "title" = COALESCE(pr."title", m."artifact_name"),
  "html_url" = COALESCE(pr."html_url", m."artifact_external_url")
FROM "_pln587_pr_branch_map" m
WHERE pr."id" = m."pull_request_detail_id";

WITH ranked AS (
  SELECT
    m."pull_request_detail_id",
    m."branch_artifact_id",
    row_number() OVER (
      PARTITION BY m."branch_artifact_id"
      ORDER BY
        (m."pr_state" = 'OPEN') DESC,
        m."artifact_updated_at" DESC,
        m."number" DESC,
        m."pull_request_artifact_id" ASC
    ) AS rn
  FROM "_pln587_pr_branch_map" m
)
UPDATE "pull_request_detail" pr
SET "is_current" = ranked.rn = 1
FROM ranked
WHERE pr."id" = ranked."pull_request_detail_id";

WITH current_pr AS (
  SELECT "branch_artifact_id", "pull_request_detail_id"
  FROM (
    SELECT
      m."branch_artifact_id",
      m."pull_request_detail_id",
      row_number() OVER (
        PARTITION BY m."branch_artifact_id"
        ORDER BY
          (m."pr_state" = 'OPEN') DESC,
          m."artifact_updated_at" DESC,
          m."number" DESC,
          m."pull_request_artifact_id" ASC
      ) AS rn
    FROM "_pln587_pr_branch_map" m
  ) ranked
  WHERE rn = 1
)
UPDATE "branch_detail" bd
SET "current_pull_request_detail_id" = current_pr."pull_request_detail_id"
FROM current_pr
WHERE bd."artifact_id" = current_pr."branch_artifact_id";

ALTER TABLE "github_pr_reviews" DROP CONSTRAINT IF EXISTS "github_pr_reviews_pull_request_id_fkey";
ALTER TABLE "github_pr_review_comments" DROP CONSTRAINT IF EXISTS "github_pr_review_comments_pull_request_id_fkey";
ALTER TABLE "branch_detail" DROP CONSTRAINT IF EXISTS "branch_detail_current_pull_request_detail_id_fkey";
ALTER TABLE "pull_request_detail" DROP CONSTRAINT IF EXISTS "pull_request_detail_artifact_id_fkey";

ALTER TABLE "pull_request_detail" DROP CONSTRAINT IF EXISTS "pull_request_detail_pkey";
ALTER TABLE "pull_request_detail" ALTER COLUMN "artifact_id" DROP NOT NULL;
ALTER TABLE "pull_request_detail" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "pull_request_detail" ALTER COLUMN "branch_artifact_id" SET NOT NULL;
ALTER TABLE "pull_request_detail" ADD CONSTRAINT "pull_request_detail_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "pull_request_detail_artifact_id_key"
  ON "pull_request_detail"("artifact_id");

UPDATE "pull_request_detail" pr
SET "artifact_id" = NULL
FROM "_pln587_pr_branch_map" m
WHERE pr."id" = m."pull_request_detail_id";

UPDATE "github_pr_reviews" r
SET "pull_request_id" = m."pull_request_detail_id"
FROM "_pln587_pr_branch_map" m
WHERE r."pull_request_id" = m."pull_request_artifact_id";

UPDATE "github_pr_review_comments" c
SET "pull_request_id" = m."pull_request_detail_id"
FROM "_pln587_pr_branch_map" m
WHERE c."pull_request_id" = m."pull_request_artifact_id";

UPDATE "deployment_detail" d
SET "branch_artifact_id" = COALESCE(m."branch_artifact_id", d."branch_artifact_id")
FROM "_pln587_pr_branch_map" m
WHERE d."pull_request_artifact_id" = m."pull_request_artifact_id";

UPDATE "artifact_links" al
SET "source_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE al."source_id" = m."pull_request_artifact_id";

UPDATE "artifact_links" al
SET "target_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE al."target_id" = m."pull_request_artifact_id";

UPDATE "artifact_ratings" ar
SET "artifact_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE ar."artifact_id" = m."pull_request_artifact_id";

UPDATE "artifact_evaluations" ae
SET "artifact_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE ae."artifact_id" = m."pull_request_artifact_id";

UPDATE "comment_threads" ct
SET "artifact_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE ct."artifact_id" = m."pull_request_artifact_id";

UPDATE "file_attachments" fa
SET "artifact_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE fa."artifact_id" = m."pull_request_artifact_id";

UPDATE "loops" l
SET "artifact_id" = m."branch_artifact_id"
FROM "_pln587_pr_branch_map" m
WHERE l."artifact_id" = m."pull_request_artifact_id";

DELETE FROM "artifacts" losing
USING "_pln587_pr_branch_map" m
WHERE losing."id" = m."pull_request_artifact_id"
  AND losing."id" <> m."branch_artifact_id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "artifacts"
    WHERE "type" = 'PULL_REQUEST'
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: PULL_REQUEST artifacts remain after branch promotion';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pull_request_detail"
    WHERE "branch_artifact_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'PLN-587 Migration B cannot continue: PullRequestDetail rows without branch_artifact_id remain';
  END IF;
END $$;

ALTER TABLE "pull_request_detail"
  ADD CONSTRAINT "pull_request_detail_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_current_pull_request_detail_id_fkey"
  FOREIGN KEY ("current_pull_request_detail_id") REFERENCES "pull_request_detail"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "github_pr_reviews"
  ADD CONSTRAINT "github_pr_reviews_pull_request_id_fkey"
  FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_pr_review_comments"
  ADD CONSTRAINT "github_pr_review_comments_pull_request_id_fkey"
  FOREIGN KEY ("pull_request_id") REFERENCES "pull_request_detail"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "deployment_detail_pull_request_artifact_id_idx";
ALTER TABLE "deployment_detail" DROP CONSTRAINT IF EXISTS "deployment_detail_pull_request_artifact_id_fkey";
ALTER TABLE "deployment_detail" DROP COLUMN IF EXISTS "pull_request_artifact_id";

ALTER TABLE "pull_request_detail" DROP COLUMN IF EXISTS "head_branch";
ALTER TABLE "pull_request_detail" DROP COLUMN IF EXISTS "head_sha";
ALTER TABLE "pull_request_detail" DROP COLUMN IF EXISTS "base_branch";
ALTER TABLE "pull_request_detail" DROP COLUMN IF EXISTS "checks_status";

DROP FUNCTION IF EXISTS _pln587_encode_uri_component(text);

ALTER TYPE "ArtifactType" RENAME TO "ArtifactType_old";
CREATE TYPE "ArtifactType" AS ENUM ('DOCUMENT', 'BRANCH', 'DEPLOYMENT');
ALTER TABLE "artifacts"
  ALTER COLUMN "type" TYPE "ArtifactType"
  USING "type"::text::"ArtifactType";
DROP TYPE "ArtifactType_old";
