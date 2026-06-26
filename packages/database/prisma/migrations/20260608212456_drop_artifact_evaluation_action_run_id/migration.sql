-- Drop the now-dead `action_run_id` column on `artifact_evaluations`.
--
-- This column referenced the legacy `github_action_runs` table (removed in the
-- preceding migration as part of the symphony-dispatch runtime removal). The
-- only writer was the deleted dispatch workflow-completion handler; the
-- surviving Loops ingestion path never populated it. No foreign key was ever
-- defined on this column, so the drop carries no referential dependency.

-- AlterTable
ALTER TABLE "artifact_evaluations" DROP COLUMN "action_run_id";
