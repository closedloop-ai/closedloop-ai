/**
 * @file data-revision-rebuild-stored-invocations.ts
 * @description FEA-3294 revision-38 bridge: rebuild a session's invocation
 * projection from stored deterministic rows, for the sessions the repair tail
 * works because no re-parse could reach them.
 *
 * Extracted from `data-revision-rebuild.ts` (ISS-6241) to keep that module under
 * the file-size ceiling. It is a self-contained sub-pass over an explicit id
 * list — it takes no rebuild-pass state — so it moves whole.
 */

import { DATA_REVISION } from "./data-revision.js";
// Type-only, so this erases at compile time and creates no runtime import
// cycle back into the module this was extracted from.
import type {
  DataRevisionRebuildDatabase,
  DataRevisionRebuildSummary,
} from "./data-revision-rebuild.js";

export async function rebuildStoredComponentInvocations(
  sessionIds: string[],
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const rebuild = db.rebuildComponentInvocationsFromStoredRows;
  if (!rebuild) {
    summary.errors += sessionIds.length;
    log(
      "data-revision rebuild: stored invocation reconstruction bridge unavailable"
    );
    return;
  }
  for (const sessionId of sessionIds) {
    if (!shouldContinue() || summary.storageReset) {
      return;
    }
    await applyStoredComponentInvocationRebuild(
      sessionId,
      rebuild,
      summary,
      log
    );
    await pauseAfterWrite();
  }
}

async function applyStoredComponentInvocationRebuild(
  sessionId: string,
  rebuild: NonNullable<
    DataRevisionRebuildDatabase["rebuildComponentInvocationsFromStoredRows"]
  >,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void
): Promise<void> {
  try {
    const result = await rebuild(sessionId, DATA_REVISION);
    if (result.storageReset) {
      summary.storageReset = true;
    } else if (result.rebuilt) {
      summary.rebuilt++;
      if (result.contentChanged) {
        summary.changedSessionIds.push(sessionId);
      }
    } else if (result.activeRace) {
      summary.raceSkipped++;
    } else {
      summary.errors++;
    }
  } catch (error) {
    summary.errors++;
    log(
      `data-revision rebuild: stored invocation reconstruction failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
