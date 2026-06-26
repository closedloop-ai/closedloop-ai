-- Partial unique index: at most one deferred (BLOCKED) loop per artifact+command.
-- Closes a TOCTOU race in the dispatch idempotency guard (apps/api loops
-- service create()): two concurrent autonomous dispatches for the same blocked
-- artifact both pass the findFirst "is there an existing BLOCKED loop?" check and
-- both insert a BLOCKED row. Reconciliation later releases the first to PENDING
-- and the second to PENDING on the next tick, yielding a duplicate run for what
-- should have been a single deferred dispatch. The DB now rejects the second
-- insert with P2002, which create() catches and resolves to the surviving row.
--
-- Distinct from the active-loop index (loops_active_artifact_command_version_key,
-- WHERE status IN ('PENDING','CLAIMED','RUNNING')): that index excludes BLOCKED,
-- so it never backstops deferred dispatch. NULL artifact_id rows never conflict
-- (Postgres NULL != NULL in unique indexes); only loops with a concrete linked
-- artifact are ever deferred, so every BLOCKED row this guards has a non-null
-- artifact_id. artifact_version is intentionally omitted — idempotency is per
-- (artifact, command), matching the app-level guard.
CREATE UNIQUE INDEX "loops_blocked_artifact_command_key"
ON "loops"("artifact_id", "command")
WHERE "status" = 'BLOCKED';
