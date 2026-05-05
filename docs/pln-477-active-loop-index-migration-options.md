# PLN-477 Active Loop Index Migration Options

## Problem

PLN-477 replaces the existing partial unique index on `(artifact_id, command, artifact_version)` with a broader partial unique index on `(artifact_id, command)` for active non-CHAT loops.

The new index can fail to build if production already has multiple active loops for the same `(artifact_id, command)` across different `artifact_version` values. Because the migration currently drops the old indexes before creating the new one, a failed `CREATE UNIQUE INDEX CONCURRENTLY` can leave the database without either active-loop uniqueness index.

## Approach 1: Add A Preflight Duplicate Check

Add a SQL preflight at the top of the migration that detects active duplicate `(artifact_id, command)` groups and raises an exception before any index is dropped.

Example shape:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM loops
    WHERE artifact_id IS NOT NULL
      AND command <> 'CHAT'
      AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
    GROUP BY artifact_id, command
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create loops_active_artifact_command_key: duplicate active loops exist for artifact_id + command';
  END IF;
END $$;
```

Pros:

- Prevents the worst failure mode: dropping the old index before discovering incompatible data.
- Simple and low-risk.
- Forces an operator to inspect and resolve ambiguous active loops.

Cons:

- Deployment blocks until duplicate rows are manually remediated.
- Requires a follow-up operational query/runbook to identify exact duplicate rows.

## Approach 2: Create The New Index First, Then Drop Old Indexes

Reorder the migration so it creates `loops_active_artifact_command_key` before dropping the old index.

Pros:

- If the new index fails, the old uniqueness index remains intact.
- Very small migration change.

Cons:

- Still fails if duplicate active rows exist.
- There is a temporary overlap where both indexes exist, increasing write overhead during the concurrent build.
- If the new index succeeds but dropping the old index fails, the database temporarily enforces both constraints. That is safer than no constraint, but may be stricter than intended until cleanup completes.

## Approach 3: Auto-Remediate Duplicates In The Migration

Before creating the new index, automatically mark all but one active loop per `(artifact_id, command)` as `FAILED` or `TIMED_OUT`.

Pros:

- Migration can proceed without manual intervention.
- Leaves exactly one active loop per new uniqueness group.

Cons:

- Risky product behavior: the migration chooses which user work to terminate.
- Hard to choose a universally correct survivor across `PENDING`, `CLAIMED`, and `RUNNING`.
- Could race with active execution or desktop state.
- Needs careful audit events and possibly runner cancellation, which is too much logic for a schema migration.

## Approach 4: Two-Phase Operational Rollout

Deploy application code first with the new create-time gate and stale-pending reap behavior, but keep the old index. After the new code has prevented new duplicates for a while, run an operational duplicate report and then ship the index migration.

Pros:

- Reduces the chance of duplicate data before the schema change.
- Gives operators time to observe and clean up existing rows.
- Best fit for a production system with active loop execution.

Cons:

- Requires multiple deploys or explicit rollout coordination.
- The database does not enforce the new invariant until the second phase.
- More process overhead than a single migration.

## Recommended Solution

Use a hybrid of Approach 1 and Approach 2:

1. Add a preflight duplicate check before any destructive index changes.
2. Create the new unique index before dropping the old index.
3. Only after the new index exists, drop the old unique index and companion regular index.
4. Include a companion diagnostic query in the PR or migration comment so operators can find duplicate groups if the preflight fails.

This keeps the migration fail-safe: incompatible data blocks the deploy before weakening existing constraints, and a failed new-index build leaves the old index in place. It avoids auto-terminating user work inside a migration while still making the failure mode explicit and actionable.

Suggested diagnostic query:

```sql
SELECT
  artifact_id,
  command,
  count(*) AS active_loop_count,
  array_agg(id ORDER BY created_at DESC) AS loop_ids
FROM loops
WHERE artifact_id IS NOT NULL
  AND command <> 'CHAT'
  AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
GROUP BY artifact_id, command
HAVING count(*) > 1
ORDER BY active_loop_count DESC, artifact_id, command;
```

If the diagnostic query returns rows, resolve them outside the schema migration. Prefer letting genuinely active loops finish or using existing cancellation/timeout flows so state transitions, cleanup, and audit behavior remain consistent with normal product paths.
