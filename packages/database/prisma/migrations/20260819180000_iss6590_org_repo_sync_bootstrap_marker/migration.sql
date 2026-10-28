-- ISS-6590: settle the GitHubRepoSyncState bootstrap on a durable per-org
-- completion marker instead of "the org has at least one sync-state row".
--
-- Both columns are left NULL for existing rows on purpose: an org bootstrapped
-- under the old `none: {}` selector may have been retired part-way through its
-- repo set, so it has to be swept once more before it can be called complete.
-- The sweep is a plain upsert fan-out and is idempotent, and the cron is bounded
-- to 25 orgs per hourly tick, so the one-time re-sweep is self-limiting. The
-- selector orders the never-attempted group newest-first so a brand-new org
-- cannot queue behind that whole backlog.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "github_repo_sync_bootstrap_attempted_at" TIMESTAMP(3),
ADD COLUMN     "github_repo_sync_bootstrapped_at" TIMESTAMP(3);
