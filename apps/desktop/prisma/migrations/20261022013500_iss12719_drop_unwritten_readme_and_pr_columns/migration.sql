-- ISS-12719: drop the `pack_catalog` README columns and `pull_requests.title`.
-- Operator ruling recorded in ISS-12719 version 3.
--
-- destructive-migration-ok(pack_catalog.readme_excerpt): Desktop-local SQLite
-- store: the forward-only migration runner refuses to boot a downgraded app
-- against a store migrated by a newer build, so no stale reader sees the dropped
-- column. No writer exists; the only reader was the GetCatalogReadme IPC, which
-- always answered null and had no renderer caller. Removed in the same change.
-- destructive-migration-ok(pack_catalog.readme_fetched_at): Same reasoning; no
-- writer and no reader.
ALTER TABLE "pack_catalog" DROP COLUMN "readme_excerpt";
ALTER TABLE "pack_catalog" DROP COLUMN "readme_fetched_at";
-- destructive-migration-ok(pull_requests.title): Same downgrade protection. The
-- only caller of `upsertPullRequest` passed null and the GitHub enrichment lane
-- that filled it is deleted; not in a wire or cloud contract.
ALTER TABLE "pull_requests" DROP COLUMN "title";
