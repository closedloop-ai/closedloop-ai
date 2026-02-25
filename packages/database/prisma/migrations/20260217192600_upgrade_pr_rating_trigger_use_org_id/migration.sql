-- Upgrade the org-consistency trigger to use github_pull_requests.organization_id
-- directly instead of the workstream join. The column was added in migration
-- 20260217192411, so this migration must run after that one.
--
-- Motivation: the workstream join is fragile under relationMode = "prisma" —
-- if a workstream is deleted via direct SQL (no DB-level FK enforcement),
-- the join returns no rows and the trigger would incorrectly block all
-- INSERT/UPDATE on pull_request_ratings for that PR. The denormalized column
-- on github_pull_requests is a single-table lookup with no join dependency.
--
-- Note: CREATE OR REPLACE replaces the existing function in-place; the trigger
-- binding on pull_request_ratings is unchanged and does not need to be recreated.

CREATE OR REPLACE FUNCTION check_pull_request_rating_organization_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM github_pull_requests gpr
    WHERE gpr.id = NEW.pull_request_id
      AND gpr.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'pull_request_ratings.organization_id must match github_pull_requests.organization_id for the referenced pull request'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
