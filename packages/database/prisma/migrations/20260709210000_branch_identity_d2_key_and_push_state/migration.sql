-- PRD-510 FR1 / D2 — branch identity + push-state migration (PLN-1099 Phase 0).
--
-- Replaces the installation-scoped branch key `(repository_id, branch_name)`
-- with the producer-independent D2 key `(organization_id, repository_full_name,
-- branch_name)` and adds the explicit set-once push-state columns (FR2). The
-- org column is denormalized (write-once) from the parent Artifact and
-- repository_full_name is normalized so both producers converge on one row.
--
-- Hand-written because this is a DATA migration (backfill + dedup guard +
-- add-nullable→backfill→SET NOT NULL ordering) that `prisma migrate dev` cannot
-- generate. Per packages/database/CLAUDE.md the org column is a write-once
-- denormalization of the required parent Artifact.organization_id (the SSOT).

-- NOTE: `repository_id` stays NOT NULL here — all Phase-0 producers are App-repo.
-- PLN-1099 Phase 1 makes it nullable enrichment when the desktop producer lands
-- non-App branches (and updates the read sites that assume a repository).

-- 1) Add the new columns nullable first (existing rows have no value yet).
ALTER TABLE "branch_detail"
  ADD COLUMN "organization_id" UUID,
  ADD COLUMN "repository_full_name" TEXT,
  ADD COLUMN "first_pushed_at" TIMESTAMP(3),
  ADD COLUMN "push_source" TEXT;

-- 2) Backfill organization_id from the REQUIRED parent Artifact (the org SSOT,
--    FR13). Every branch_detail row has an Artifact parent, so this covers all.
UPDATE "branch_detail" bd
SET "organization_id" = a."organization_id"
FROM "artifacts" a
WHERE a."id" = bd."artifact_id";

-- 3) Backfill repository_full_name from the joined installation repo, normalized
--    to match normalizeRepoFullName() (trim → strip trailing ".git" → lowercase).
--    Every pre-migration row had a required repository_id, so all resolve here.
UPDATE "branch_detail" bd
SET "repository_full_name" =
  lower(regexp_replace(btrim(gir."full_name"), '\.git$', ''))
FROM "github_installation_repositories" gir
WHERE gir."id" = bd."repository_id";

-- 4) Fail loud if any row could not be backfilled (would violate the incoming
--    NOT NULL). A NULL here means an orphaned repository_id — surface it rather
--    than silently drop the row from the new key.
DO $$
DECLARE
  unbackfilled BIGINT;
BEGIN
  SELECT count(*) INTO unbackfilled
  FROM "branch_detail"
  WHERE "organization_id" IS NULL OR "repository_full_name" IS NULL;
  IF unbackfilled > 0 THEN
    RAISE EXCEPTION
      'branch_identity migration: % branch_detail row(s) missing organization_id/repository_full_name after backfill — resolve orphaned repository_id rows before re-running',
      unbackfilled;
  END IF;
END $$;

-- 5) Dedup guard (PRD-510 FR1 "merge or fail-loud"). The new key can collapse
--    rows the old `(repository_id, branch_name)` key kept distinct — e.g. two
--    installation-repo rows sharing one full_name within an org. A safe
--    automatic merge would have to repoint every dependent row
--    (branch_file_changes, branch_status_checks, pull_request_detail,
--    artifact_link) to a surviving branch artifact, which cannot be done blindly
--    without data-specific review. So we FAIL LOUD: surface the colliding keys
--    for manual merge before the unique index is created. On a clean database
--    (local/CI, staged prod copy without collisions) this is a no-op.
DO $$
DECLARE
  dup_count BIGINT;
  dup_sample TEXT;
BEGIN
  SELECT count(*), string_agg(sample, '; ')
  INTO dup_count, dup_sample
  FROM (
    SELECT
      "organization_id" || ' ' || "repository_full_name" || ' ' || "branch_name" AS sample
    FROM "branch_detail"
    GROUP BY "organization_id", "repository_full_name", "branch_name"
    HAVING count(*) > 1
    LIMIT 20
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'branch_identity migration: % duplicate (organization_id, repository_full_name, branch_name) group(s) — merge them manually before re-running. Sample: %',
      dup_count, dup_sample;
  END IF;
END $$;

-- 6) Enforce NOT NULL now that every row is backfilled and deduped.
ALTER TABLE "branch_detail" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "branch_detail" ALTER COLUMN "repository_full_name" SET NOT NULL;

-- 7) Swap the unique key: drop the old installation-scoped index, add the D2 key.
DROP INDEX "branch_detail_repository_id_branch_name_key";
CREATE UNIQUE INDEX "branch_detail_org_repo_full_name_branch_key"
  ON "branch_detail" ("organization_id", "repository_full_name", "branch_name");

-- 8) FR12 display-predicate index (org-scoped push-evidence scans).
CREATE INDEX "branch_detail_org_first_pushed_at_idx"
  ON "branch_detail" ("organization_id", "first_pushed_at");

-- 9) Org FK (write-once denormalization; referential integrity to the parent
--     org). Matches Artifact.organization (default RESTRICT — org deletion is
--     already blocked by existing artifacts).
ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
