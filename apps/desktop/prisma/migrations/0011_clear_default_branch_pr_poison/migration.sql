-- FEA-2260: Clear poisoned default-branch attribution on PR artifacts and rows.
-- Worktree sessions reported the session CWD branch (main/master/develop) as the
-- PR head branch; the extractor trusted it and wrote it to both tables.

-- Step 1: Clear pull_requests rows FIRST (before we null the artifact branch_name).
-- A PR row is poisoned when it says 'main' but the enriched artifact for that PR
-- has a DIFFERENT branch_name (the real head ref from GitHub). Cross-fork PRs
-- where both agree on 'main' (enrichment_state = 'final') are preserved.
-- Also clear rows whose artifact has no enrichment_state or is non-final — these
-- were never confirmed by GitHub.
UPDATE pull_requests
SET branch_name = NULL
WHERE branch_name IN ('main', 'master', 'develop', 'HEAD')
  AND NOT EXISTS (
    SELECT 1 FROM artifacts a
    WHERE a.kind = 'pull_request'
      AND a.repo_full_name = pull_requests.repo_full_name
      AND a.pr_number = pull_requests.pr_number
      AND a.enrichment_state = 'final'
      AND a.branch_name = pull_requests.branch_name
  );

-- Step 2: Clear poisoned artifacts (non-final or NULL enrichment_state).
-- COALESCE handles NULL enrichment_state (artifacts inserted before sweep runs).
-- Reset enrichment metadata so the sweep retries with the bad branch removed.
UPDATE artifacts
SET branch_name = NULL,
    enrichment_state = 'provisional',
    enrichment_attempts = 0,
    enriched_at = NULL
WHERE kind = 'pull_request'
  AND branch_name IN ('main', 'master', 'develop', 'HEAD')
  AND COALESCE(enrichment_state, 'unknown') != 'final';
