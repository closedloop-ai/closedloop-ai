-- Enforce organizationId consistency: rating.organization_id must match the PR's
-- workstream.organization_id. PostgreSQL CHECK constraints cannot reference other
-- tables, so we use a trigger. This prevents inconsistent data from manual SQL,
-- migrations, or future code paths that bypass the service layer.

-- Fail migration if existing data is inconsistent (would violate trigger)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pull_request_ratings prr
    JOIN github_pull_requests gpr ON gpr.id = prr.pull_request_id
    JOIN workstreams w ON w.id = gpr.workstream_id
    WHERE prr.organization_id != w.organization_id
  ) THEN
    RAISE EXCEPTION 'Found pull_request_ratings with organization_id not matching PR workstream - fix data before applying this migration';
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
    JOIN workstreams w ON w.id = gpr.workstream_id
    WHERE gpr.id = NEW.pull_request_id
      AND w.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'pull_request_ratings.organization_id must match workstream.organization_id for the referenced pull request'
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
