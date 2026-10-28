-- ISS-12344: the PR head GitHub confirmed, written only by the cloud overlay
-- (cloud-github-loc-artifact-persistence.ts). While it is set the importer
-- keeps the PR's branch_name on it, so re-importing a command session cannot
-- write the command's one head back over the head GitHub reported.
--
-- One nullable TEXT column with no default. NULL is every PR the cloud has not
-- confirmed a head for, and those keep the importer's head as before.
--
-- Plain `ADD COLUMN` (SQLite has no `IF NOT EXISTS` for it).
ALTER TABLE "artifacts" ADD COLUMN "github_head_branch" TEXT;
