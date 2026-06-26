-- perf: index branch_name for the per-import branch/PR link join.
--
-- `propagateBranchPrLinks` (apps/desktop/src/main/database/sqlite.ts) runs on
-- EVERY session import. It joins session_artifact_links → artifacts (the head
-- branch, kind='branch') → pull_requests → artifacts (the PR), matching the
-- branch to its PR on (repo_full_name, branch_name) across both tables. Neither
-- branch_name column was indexed:
--   * artifacts had idx_artifacts_repo_pr (repo_full_name, pr_number) — no
--     branch_name, so the kind='branch' side of the join scanned.
--   * pull_requests had idx_pr_repo (repo_full_name, pr_number) — also no
--     branch_name, so the pr.branch_name = branch.branch_name match scanned.
--
-- These two indexes serve exactly those join predicates. The artifacts index is
-- partial on kind='branch' (the only rows the join touches via the `branch`
-- alias), keeping it small.
CREATE INDEX IF NOT EXISTS "idx_artifacts_branch" ON "artifacts"("repo_full_name", "branch_name") WHERE kind = 'branch';
CREATE INDEX IF NOT EXISTS "idx_pull_requests_branch" ON "pull_requests"("repo_full_name", "branch_name");
