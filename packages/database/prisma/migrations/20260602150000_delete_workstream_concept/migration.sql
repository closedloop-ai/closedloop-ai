-- Delete the Workstream concept entirely (FEA-1496 / PLN-787).
--
-- Why hand-written (per packages/database/CLAUDE.md):
--   1. Data steps Prisma cannot express: pre-clearing WORKSTREAM references in
--      custom_fields.entity_types arrays, deleting orphaned github_action_runs
--      rows, and backfilling github_action_runs.organization_id from the
--      workstream relation before SET NOT NULL.
--   2. Prisma's diff would ADD COLUMN organization_id NOT NULL directly, which
--      fails immediately on any DB with existing rows. We split it into
--      ADD nullable → backfill → SET NOT NULL.
--   3. The Postgres enum rename pattern (CustomFieldEntityType) requires
--      pre-clearing WORKSTREAM values from referencing tables; the rename CAST
--      otherwise fails on out-of-enum values.
--
-- The remaining DDL (drop FKs, drop indexes, drop columns, drop tables, drop
-- enums, create new index, add new FK) matches Prisma's diff exactly.
--
-- Out of scope: linear_subtasks.workstream_id stays as a free-floating UUID
-- column with no Prisma relation. Separate audit follow-up.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pre-clear WORKSTREAM references that block the CustomFieldEntityType
--    enum rename. The enum-rename CAST below would otherwise fail on any row
--    whose entity_type / entity_types still contains the WORKSTREAM value.
-- ---------------------------------------------------------------------------
DELETE FROM custom_field_values WHERE entity_type = 'WORKSTREAM';
DELETE FROM custom_field_settings WHERE entity_type = 'WORKSTREAM';
UPDATE custom_fields
SET entity_types = array_remove(entity_types, 'WORKSTREAM')
WHERE 'WORKSTREAM' = ANY(entity_types);

-- ---------------------------------------------------------------------------
-- 2. Orphan cleanup: github_action_runs has no DB-level FK to workstreams
--    (the column was always a scalar UUID). Rows pointing at a workstream
--    that no longer exists would leave organization_id NULL after the
--    backfill below, then fail SET NOT NULL. Delete the orphans.
-- ---------------------------------------------------------------------------
DELETE FROM github_action_runs
WHERE workstream_id NOT IN (SELECT id FROM workstreams);

-- ---------------------------------------------------------------------------
-- 3. Add organization_id to github_action_runs (nullable), backfill from the
--    workstream relation (every workstream has organization_id NOT NULL), then
--    enforce NOT NULL. The FK and index are added later, after the workstream
--    table is dropped.
-- ---------------------------------------------------------------------------
ALTER TABLE github_action_runs ADD COLUMN organization_id UUID;

UPDATE github_action_runs
SET organization_id = workstreams.organization_id
FROM workstreams
WHERE github_action_runs.workstream_id = workstreams.id;

ALTER TABLE github_action_runs ALTER COLUMN organization_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Drop the existing workstream-keyed FKs and indexes on dependents so the
--    workstream / workstream_events / tag_workstreams tables can be dropped.
-- ---------------------------------------------------------------------------
ALTER TABLE artifacts DROP CONSTRAINT "artifacts_workstream_id_fkey";
ALTER TABLE loops DROP CONSTRAINT "loops_workstream_id_fkey";
ALTER TABLE tag_workstreams DROP CONSTRAINT "tag_workstreams_tag_id_fkey";
ALTER TABLE tag_workstreams DROP CONSTRAINT "tag_workstreams_workstream_id_fkey";
ALTER TABLE workstreams DROP CONSTRAINT "workstreams_assigned_to_id_fkey";
ALTER TABLE workstreams DROP CONSTRAINT "workstreams_created_by_id_fkey";
ALTER TABLE workstreams DROP CONSTRAINT "workstreams_organization_id_fkey";
ALTER TABLE workstreams DROP CONSTRAINT "workstreams_project_id_fkey";

DROP INDEX "artifacts_organization_id_workstream_id_type_idx";
DROP INDEX "github_action_runs_workstream_id_status_idx";
DROP INDEX "github_action_runs_workstream_id_workflow_name_idx";
DROP INDEX "loops_workstream_id_idx";

-- ---------------------------------------------------------------------------
-- 5. Drop scalar workstream_id columns now that all dependents are detached.
--    Note: workstream_events, conversations, messages, linear_issues already
--    have no DB-level FK to workstreams (scalar columns only), so they drop
--    cleanly as tables in step 6 without any prior FK detach work.
-- ---------------------------------------------------------------------------
ALTER TABLE artifacts DROP COLUMN workstream_id;
ALTER TABLE github_action_runs DROP COLUMN workstream_id;
ALTER TABLE loops DROP COLUMN workstream_id;

-- ---------------------------------------------------------------------------
-- 6. Drop tables. workstream_events satellite columns (from_state, to_state)
--    referencing WorkstreamState go away with the table — no separate column
--    drop is needed (attempting one after the table is gone fails).
-- ---------------------------------------------------------------------------
DROP TABLE tag_workstreams;
DROP TABLE workstream_events;
DROP TABLE workstreams;
DROP TABLE messages;
DROP TABLE conversations;
DROP TABLE linear_issues;

-- ---------------------------------------------------------------------------
-- 7. Rename CustomFieldEntityType to drop the WORKSTREAM value.
--    Postgres does not support ALTER TYPE ... DROP VALUE on enums that have
--    ever been referenced — even after the rows are pre-cleared in step 1.
--    The rename + recreate + cast + drop pattern is required.
-- ---------------------------------------------------------------------------
CREATE TYPE "CustomFieldEntityType_new" AS ENUM ('PROJECT', 'DOCUMENT');
ALTER TABLE custom_fields ALTER COLUMN entity_types DROP DEFAULT;
ALTER TABLE custom_fields
  ALTER COLUMN entity_types
  TYPE "CustomFieldEntityType_new"[]
  USING (entity_types::text[]::"CustomFieldEntityType_new"[]);
ALTER TABLE custom_field_settings
  ALTER COLUMN entity_type
  TYPE "CustomFieldEntityType_new"
  USING (entity_type::text::"CustomFieldEntityType_new");
ALTER TABLE custom_field_values
  ALTER COLUMN entity_type
  TYPE "CustomFieldEntityType_new"
  USING (entity_type::text::"CustomFieldEntityType_new");
ALTER TYPE "CustomFieldEntityType" RENAME TO "CustomFieldEntityType_old";
ALTER TYPE "CustomFieldEntityType_new" RENAME TO "CustomFieldEntityType";
DROP TYPE "CustomFieldEntityType_old";
ALTER TABLE custom_fields
  ALTER COLUMN entity_types
  SET DEFAULT ARRAY[]::"CustomFieldEntityType"[];

-- ---------------------------------------------------------------------------
-- 8. Drop the now-unreferenced workstream-domain enums.
-- ---------------------------------------------------------------------------
DROP TYPE "WorkstreamEventType";
DROP TYPE "WorkstreamState";
DROP TYPE "WorkstreamType";
DROP TYPE "LinearSyncStatus";

-- ---------------------------------------------------------------------------
-- 9. Add the new index + FK on github_action_runs.organization_id.
-- ---------------------------------------------------------------------------
CREATE INDEX "github_action_runs_organization_id_status_idx"
  ON github_action_runs (organization_id, status);
CREATE INDEX "github_action_runs_organization_id_workflow_name_idx"
  ON github_action_runs (organization_id, workflow_name);
ALTER TABLE github_action_runs
  ADD CONSTRAINT "github_action_runs_organization_id_fkey"
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 10. Drop the public-dashboard surface. The "public dashboard" feature was a
--     read-only org-token-gated stats page; the user confirmed it can be
--     removed wholesale. Dropping the column cascades the UNIQUE index
--     automatically.
-- ---------------------------------------------------------------------------
ALTER TABLE organizations DROP COLUMN IF EXISTS public_dashboard_token;

COMMIT;
