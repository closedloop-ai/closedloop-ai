import type { BatchItemResult } from "@repo/api/src/types/batch-mutation-result";
import { withDb } from "@repo/database";

/**
 * Shared by the two ISS-9464 per-item integration suites, which cannot share a
 * DB harness (one rolls back, one commits) but do read results and rows the
 * same way.
 */

/**
 * The result for one id, as an assertion subject. Fails loudly rather than
 * returning `undefined`, because a missing id would otherwise read as a passing
 * `toBeUndefined`-shaped expectation somewhere downstream.
 */
export function resultFor(
  results: ReadonlyMap<string, BatchItemResult>,
  id: string
): BatchItemResult {
  const result = results.get(id);
  if (!result) {
    throw new Error(`no per-item result for ${id}`);
  }
  return result;
}

/** An artifact's persisted `projectId` — a document or a session alike. */
export function readArtifactProjectId(
  id: string
): Promise<string | null | undefined> {
  return withDb(async (db) => {
    const row = await db.artifact.findUnique({
      where: { id },
      select: { projectId: true },
    });
    return row?.projectId;
  });
}
