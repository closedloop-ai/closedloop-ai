/**
 * ISS-4810 / ISS-4811: the shared precondition for exercising the STORED-ROW
 * invocation rebuild bridge from a test.
 *
 * Production only ever hands that bridge sessions the stale sweep selected —
 * rows whose `data_revision` differs from the current one (migration
 * `0045_iss4778_phantom_command_backfill` stamps `data_revision = 0` on every
 * phantom-bearing session) — and the bridge now re-checks that inside its own
 * write transaction (whitlockk, #4255) so an ordinary import that seals the session
 * first is never clobbered by the lossy stored-row reconstruction.
 *
 * `importSession` stamps the CURRENT revision, so a test that imports and then
 * calls the bridge is asking it to no-op. Stale the row explicitly instead of
 * relying on that guard being absent, in ONE place so the four suites that drive
 * this bridge cannot drift on the precondition.
 */

import { effectiveDataRevision } from "../../src/main/collectors/engine/effective-data-revision.js";

/** The slice of the SQLite database handle this helper drives. */
type StoredRebuildDb = {
  run(sql: string, ...params: unknown[]): Promise<unknown>;
  rebuildComponentInvocationsFromStoredRows(
    sessionId: string,
    currentRevision: number
  ): Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    needsResync?: boolean;
  }>;
};

/** Mark `sessionId` stale so the stored-row rebuild bridge will act on it. */
export function markStaleForRebuild(
  db: StoredRebuildDb,
  sessionId: string
): Promise<unknown> {
  return db.run(
    "UPDATE sessions SET data_revision = $1 WHERE id = $2",
    effectiveDataRevision() - 1,
    sessionId
  );
}

/** Stale `sessionId`, then run the stored-row rebuild against it. */
export async function staleRebuildFromStoredRows(
  db: StoredRebuildDb,
  sessionId: string
): Promise<{
  rebuilt: boolean;
  activeRace: boolean;
  needsResync?: boolean;
}> {
  await markStaleForRebuild(db, sessionId);
  return await db.rebuildComponentInvocationsFromStoredRows(
    sessionId,
    effectiveDataRevision()
  );
}
