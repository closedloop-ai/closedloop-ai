import { log } from "@repo/observability/log";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { docSyncInternalClient } from "./internal-client";

/**
 * PLN-2200 T-5.4: deletes the document's doc-sync state alongside its
 * Liveblocks room. Never throws, so a document delete never fails on
 * doc-sync (AC-018); a failure is logged, and the daily sweep
 * (`/cron/sweep-doc-sync-state`) removes the state later.
 */
export async function deleteDocSyncDocument(roomId: string): Promise<void> {
  const result = await docSyncInternalClient().deleteDocument(roomId);
  if (result.ok || result.failure === InternalCallFailure.NotConfigured) {
    return;
  }
  log.error("Doc-sync document delete failed", {
    event: DOC_SYNC_DELETE_FAILED_EVENT,
    roomId,
    failure: result.failure,
    status: result.status,
  });
}

export const DOC_SYNC_DELETE_FAILED_EVENT = "doc_sync.delete_failed";
