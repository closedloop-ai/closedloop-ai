-- Partial unique index: prevents concurrent duplicate loops for the same
-- artifact+command+version, but only for active (non-terminal) loops.
-- Terminal loops (COMPLETED/FAILED/CANCELLED/TIMED_OUT) are excluded so
-- users can re-run or request changes on a previously evaluated version.
-- NULL artifact_version rows never conflict (Postgres NULL != NULL in indexes).
CREATE UNIQUE INDEX "loops_active_artifact_command_version_key"
ON "loops"("artifact_id", "command", "artifact_version")
WHERE "status" IN ('PENDING', 'CLAIMED', 'RUNNING');

-- Regular index for non-status-filtered queries (query performance).
CREATE INDEX "loops_artifact_id_command_artifact_version_idx" ON "loops"("artifact_id", "command", "artifact_version");
