-- Store provider-owned pull request LOC on the PR detail row so Branches
-- analytics can compute PR-size KPIs without reading branch file-change cache.
ALTER TABLE "pull_request_detail"
ADD COLUMN "additions" INTEGER,
ADD COLUMN "deletions" INTEGER,
ADD COLUMN "changed_files" INTEGER;
