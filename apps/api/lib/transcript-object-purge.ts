import { log } from "@repo/observability/log";

/**
 * Best-effort deletion of transcript archive objects from the transcripts
 * bucket, shared by every delete path that reclaims them (compute-target delete
 * in `compute-targets/service.ts` and the session-retention sweep in
 * `agent-sessions/retention-service.ts`). The caller passes the storage keys it
 * already collected (before dropping the rows that carried them) plus a log
 * message and context. This never throws: it runs after the row delete has
 * committed, so an S3 failure must be logged with the orphaned keys for
 * follow-up cleanup rather than propagated — the backing rows are already gone
 * and the caller must not roll back on a storage error. Empty input is a no-op.
 *
 * `@repo/aws` is imported lazily because it begins with `import "server-only"`,
 * which throws when evaluated outside Next.js — e.g. the desktop gateway socket
 * server statically imports `compute-targets/service.ts` and the post-build
 * `server:import-smoke` script loads it under `tsx` (no Next runtime). Deferring
 * the import keeps the S3 dependency off the eager import graph of every module
 * that calls this helper.
 */
export async function purgeTranscriptObjectsBestEffort(
  keys: string[],
  message: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  try {
    const { deleteTranscriptObjects } = await import("@repo/aws");
    await deleteTranscriptObjects(keys);
  } catch (error) {
    log.error(message, {
      ...context,
      objectCount: keys.length,
      objectStorageKeys: keys,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
