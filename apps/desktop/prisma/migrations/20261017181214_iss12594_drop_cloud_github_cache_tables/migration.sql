-- ISS-12594: drop `cloud_github_branch_overlays`, the durable cache of
-- cloud-sourced GitHub branch overlays (created by 0012). Operator ruling
-- 2026-10-17: data from the cloud is not stored locally, so a Desktop that is
-- offline shows no GitHub data. The readers (the hydration fallbacks and the
-- eligibility merge) and the writer are deleted in the same change.
--
-- The same ruling drops `repository_default_authorities`, the account-scoped
-- cache of each repository's default branch (ISS-5838), which was read back to
-- fill repositories a page-limited cloud response did not carry. Eligibility now
-- uses the current response only.
--
-- Dropping a table drops its indexes with it. `artifacts` and `pull_requests`
-- columns the removed projection once filled keep their last values; they are
-- not cleared here.
DROP TABLE IF EXISTS "cloud_github_branch_overlays";
DROP TABLE IF EXISTS "repository_default_authorities";
