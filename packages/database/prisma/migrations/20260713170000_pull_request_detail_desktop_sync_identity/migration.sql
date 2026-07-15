-- FEA-2732 / PRD-510 D2 (PLN-1299 Phase 1) — PullRequestDetail gains a
-- producer-independent identity so the desktop can sync PRs for non-App repos
-- into the SAME rows the GitHub App webhook writes.
--
-- Today PullRequestDetail assumes App-installed repos: repository_id is a
-- required FK, github_id is required + globally unique, and identity is
-- (repository_id, number). Desktop-produced PRs in non-App repos have neither a
-- repository_id nor (initially) a github_id, so this migration mirrors the
-- BranchDetail D2 treatment (20260709210000 / 20260709211500):
--   * repository_id + github_id become nullable enrichment,
--   * organization_id is a write-once denormalization of the parent branch
--     Artifact's org (the SSOT), so repo-less identity can be org-scoped,
--   * repository_full_name is the normalized producer-independent identity
--     component, and
--   * a PARTIAL unique index keys repo-less rows on
--     (organization_id, repository_full_name, number) so re-sync is idempotent,
--     two orgs syncing the same public repo's PR stay isolated, and a later App
--     installation ADOPTS the same row (fills repository_id/github_id) instead of
--     duplicating it.
--
-- Hand-written because this is a DATA migration (add-nullable -> backfill ->
-- SET NOT NULL ordering) plus a PARTIAL unique index, neither of which
-- `prisma migrate dev` can generate (packages/database/CLAUDE.md).

-- 1) Add the new columns nullable first (existing rows have no value yet).
ALTER TABLE "pull_request_detail"
  ADD COLUMN "organization_id" UUID,
  ADD COLUMN "repository_full_name" TEXT;

-- 2) repository_id becomes nullable enrichment; relax its FK from the implicit
--    RESTRICT to SET NULL so removing an installation repo leaves the PR as a
--    non-App row rather than blocking deletion (matches the optional Prisma
--    relation default and the BranchDetail treatment).
ALTER TABLE "pull_request_detail" ALTER COLUMN "repository_id" DROP NOT NULL;
ALTER TABLE "pull_request_detail" DROP CONSTRAINT "pull_request_detail_repository_id_fkey";
ALTER TABLE "pull_request_detail"
  ADD CONSTRAINT "pull_request_detail_repository_id_fkey"
  FOREIGN KEY ("repository_id") REFERENCES "github_installation_repositories" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3) github_id becomes nullable (desktop-only rows have no canonical node id
--    until `gh` enrichment or App adoption supplies one). The existing unique
--    index stays: Postgres treats NULLs as distinct, so many desktop rows may
--    share a NULL github_id.
ALTER TABLE "pull_request_detail" ALTER COLUMN "github_id" DROP NOT NULL;

-- 4) Backfill organization_id from the REQUIRED parent branch Artifact (the org
--    SSOT, FR13). Every pull_request_detail row nests under a branch Artifact via
--    branch_artifact_id, so this covers all rows.
UPDATE "pull_request_detail" prd
SET "organization_id" = a."organization_id"
FROM "artifacts" a
WHERE a."id" = prd."branch_artifact_id";

-- 5) Backfill repository_full_name from the joined installation repo, normalized
--    to match normalizeRepoFullName() (trim -> strip trailing ".git" ->
--    lowercase). Every pre-migration row had a required repository_id, so all
--    resolve here. (repository_full_name stays nullable: it is enrichment for App
--    rows and is always set by the desktop producer for repo-less rows.)
UPDATE "pull_request_detail" prd
SET "repository_full_name" =
  lower(regexp_replace(btrim(gir."full_name"), '\.git$', ''))
FROM "github_installation_repositories" gir
WHERE gir."id" = prd."repository_id";

-- 6) Fail loud if any row could not be backfilled for organization_id (would
--    violate the incoming NOT NULL). A NULL here means an orphaned
--    branch_artifact_id — surface it rather than silently dropping the row.
DO $$
DECLARE
  unbackfilled BIGINT;
BEGIN
  SELECT count(*) INTO unbackfilled
  FROM "pull_request_detail"
  WHERE "organization_id" IS NULL;
  IF unbackfilled > 0 THEN
    RAISE EXCEPTION
      'pull_request_detail identity migration: % row(s) missing organization_id after backfill — resolve orphaned branch_artifact_id rows before re-running',
      unbackfilled;
  END IF;
END $$;

-- 7) Enforce NOT NULL now that every row is backfilled.
ALTER TABLE "pull_request_detail" ALTER COLUMN "organization_id" SET NOT NULL;

-- 8) Org-scoping index (isolation-scoped scans / FK support), matching Prisma's
--    @@index([organizationId]) naming so `prisma migrate diff` reports no drift.
CREATE INDEX "pull_request_detail_organization_id_idx"
  ON "pull_request_detail" ("organization_id");

-- 9) Org FK (write-once denormalization; referential integrity to the parent
--    org). RESTRICT/CASCADE matches the required Prisma relation default and the
--    BranchDetail org FK.
ALTER TABLE "pull_request_detail"
  ADD CONSTRAINT "pull_request_detail_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10) PARTIAL unique index — the producer-independent identity for repo-less
--     desktop rows. No dedup guard is needed: every pre-migration row has a
--     non-null repository_id, so this partial index (WHERE repository_id IS NULL)
--     matches ZERO existing rows and cannot collide on backfilled data. A later
--     App installation fills repository_id (adoption), moving the row out of this
--     index and under the existing (repository_id, number) unique key.
CREATE UNIQUE INDEX "pull_request_detail_org_repo_full_name_number_key"
  ON "pull_request_detail" ("organization_id", "repository_full_name", "number")
  WHERE "repository_id" IS NULL;
