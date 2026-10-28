-- ISS-7209: custom fields become attachable to SESSION and BRANCH artifacts.
--
-- Purely additive: no existing row carries either value, and `entity_type` is a
-- plain PostgreSQL enum column with no CHECK constraint on it (the only CHECK
-- this area ever had was on `artifacts.project_id`, dropped in
-- 20260715210000_allow_unparented_artifacts_and_retire_templates_sentinel), so
-- nothing needs backfilling or re-validating.
ALTER TYPE "CustomFieldEntityType" ADD VALUE 'SESSION';

-- AlterEnum
ALTER TYPE "CustomFieldEntityType" ADD VALUE 'BRANCH';
