-- PRD-510 D2/FR8 — branch repository_id becomes nullable enrichment
-- (PLN-1099 Phase 1). Desktop-produced branches in non-App repos have no
-- installation-repo surrogate id; branch identity keys on the D2 tuple
-- (organization_id, repository_full_name, branch_name) instead.
--
-- The FK also relaxes from RESTRICT to SET NULL: when an installation repo is
-- removed the branch survives as a non-App branch (repository_id cleared) rather
-- than blocking deletion. This matches the Prisma optional-relation default, so
-- the schema carries no explicit onDelete on `repository`.

ALTER TABLE "branch_detail" ALTER COLUMN "repository_id" DROP NOT NULL;

ALTER TABLE "branch_detail" DROP CONSTRAINT "branch_detail_repository_id_fkey";
ALTER TABLE "branch_detail"
  ADD CONSTRAINT "branch_detail_repository_id_fkey"
  FOREIGN KEY ("repository_id") REFERENCES "github_installation_repositories" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
