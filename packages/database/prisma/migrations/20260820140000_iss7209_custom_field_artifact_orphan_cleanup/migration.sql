-- ISS-7209: reap custom-field rows when the artifact they hang off is deleted.
--
-- `custom_field_settings` and `custom_field_values` address their subject
-- polymorphically, as (`entity_type`, `entity_id`), so neither can carry a
-- foreign key to `artifacts` and neither is reached by ON DELETE CASCADE. The
-- rows therefore outlive their artifact, and because `entity_id` is a uuid PK
-- from a shared sequence-free space, an orphan is not merely dead weight: it is
-- attached to an id that a later artifact could legitimately present, which is
-- how one entity ends up reading another's custom-field data.
--
-- Application-side cleanup would have to be repeated at every deletion site --
-- document delete, merge, branch delete, deployment delete, compute-target
-- teardown, the session retention and phantom-retention sweeps, and two purge
-- scripts -- and would silently regress the moment a tenth site is added. The
-- database is the only place that sees all of them, so the reap lives here.
--
-- DOCUMENT, SESSION and BRANCH all address `artifacts.id`; PROJECT does not,
-- and is deliberately excluded so a project's settings are untouched by an
-- artifact delete.
--
-- Statement-level with a transition table, not FOR EACH ROW: the retention
-- sweeps delete in large batches, and a per-row trigger would turn one bulk
-- DELETE into two extra statements per artifact.
CREATE OR REPLACE FUNCTION "reap_custom_field_rows_for_deleted_artifacts"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "custom_field_values" v
  USING deleted_artifacts d
  WHERE v."entity_id" = d."id"
    AND v."organization_id" = d."organization_id"
    AND v."entity_type" IN ('DOCUMENT', 'SESSION', 'BRANCH');

  DELETE FROM "custom_field_settings" s
  USING deleted_artifacts d
  WHERE s."entity_id" = d."id"
    AND s."organization_id" = d."organization_id"
    AND s."entity_type" IN ('DOCUMENT', 'SESSION', 'BRANCH');

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "artifacts_reap_custom_field_rows" ON "artifacts";

CREATE TRIGGER "artifacts_reap_custom_field_rows"
AFTER DELETE ON "artifacts"
REFERENCING OLD TABLE AS deleted_artifacts
FOR EACH STATEMENT
EXECUTE FUNCTION "reap_custom_field_rows_for_deleted_artifacts"();

-- Clear the orphans that existing deletions already left behind. Bounded by the
-- rows that have no surviving artifact, and scoped to the artifact-backed entity
-- types so PROJECT rows are never considered.
DELETE FROM "custom_field_values" v
WHERE v."entity_type" IN ('DOCUMENT', 'SESSION', 'BRANCH')
  AND NOT EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = v."entity_id");

DELETE FROM "custom_field_settings" s
WHERE s."entity_type" IN ('DOCUMENT', 'SESSION', 'BRANCH')
  AND NOT EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = s."entity_id");
