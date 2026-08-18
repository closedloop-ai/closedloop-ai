-- Persist provider-reported PR head Branch identity for dual-evidence Product
-- eligibility. Existing rows intentionally remain NULL until an authoritative
-- projection refreshes them; no Branch-row-derived backfill is truthful.
ALTER TABLE "pull_request_detail"
ADD COLUMN "head_ref_name" TEXT;

-- Prisma cannot express this rolling-deploy transition guard. An invocation of
-- the pre-migration application can still finish during a
-- rolling deploy and update head_ref_oid without knowing head_ref_name. Clear
-- the new member when a complete pair changes outside an authority generation
-- so mixed-time evidence fails closed until the next authoritative refresh.
CREATE FUNCTION "guard_pull_request_head_ref_pair"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."head_ref_name" IS NOT NULL
    AND OLD."head_ref_oid" IS NOT NULL
    AND NEW."head_ref_oid" IS DISTINCT FROM OLD."head_ref_oid"
    AND NEW."head_ref_name" IS NOT DISTINCT FROM OLD."head_ref_name"
    AND NEW."head_repository_default_branch_source"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_source"
    AND NEW."head_repository_default_branch_observation_key"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_observation_key"
    AND NEW."head_repository_default_branch_observed_at"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_observed_at"
    AND NEW."head_repository_default_branch_event_at"
      IS NOT DISTINCT FROM OLD."head_repository_default_branch_event_at"
  THEN
    NEW."head_ref_name" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pull_request_detail_head_ref_pair_guard"
BEFORE UPDATE OF "head_ref_oid" ON "pull_request_detail"
FOR EACH ROW
EXECUTE FUNCTION "guard_pull_request_head_ref_pair"();
