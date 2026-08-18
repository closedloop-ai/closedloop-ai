-- FEA-3552: persist the GitHub PR `created_at` (when the PR was actually raised)
-- so the branch/PR timeline can render a distinct "PR opened" lifecycle dot at
-- the true open instant, separate from the "PR merged" dot at `merged_at`. Before
-- this, cloud/web hardcoded `openedAt: null` (the FEA-3457 deferral — no persisted
-- column existed) so the only PR marker rendered was the merge dot, collapsing the
-- whole open->merge lifecycle onto the merge time.
--
-- Additive, append-only, nullable column with no NOT NULL and no backfill:
-- producers (GitHub webhook, gh-fetch read-repair, desktop sync) fill it forward
-- as PRs are (re)projected; historical rows stay NULL (no opened dot) rather than
-- being fabricated from another timestamp. Safe to apply ahead of the readers.
-- Generated offline (no DB reachable in the authoring sandbox); applied by
-- `prisma migrate deploy` in CI/prod.

-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN "github_created_at" TIMESTAMP(3);
