-- Enforce organizationId consistency: rating.organization_id must match the PR's
-- organization_id (denormalized on github_pull_requests in migration 20260217192411).
-- PostgreSQL CHECK constraints cannot reference other tables, so we use a trigger.
-- This prevents inconsistent data from manual SQL, migrations, or future code paths
-- that bypass the service layer.
-- Note: uses github_pull_requests.organization_id directly (not workstream join) so
-- the check remains valid even if a workstream is deleted via direct SQL
-- (relationMode = "prisma" provides no DB-level FK enforcement on workstream_id).

-- Fail migration if existing data is inconsistent (would violate trigger)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pull_request_ratings prr
    JOIN github_pull_requests gpr ON gpr.id = prr.pull_request_id
    WHERE prr.organization_id != gpr.organization_id
  ) THEN
    RAISE EXCEPTION 'Found pull_request_ratings with organization_id not matching github_pull_requests.organization_id - fix data before applying this migration';
  END IF;
END
$$;

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

CREATE TRIGGER pull_request_ratings_org_id_check
  BEFORE INSERT OR UPDATE OF organization_id, pull_request_id
  ON pull_request_ratings
  FOR EACH ROW
  EXECUTE FUNCTION check_pull_request_rating_organization_id();
