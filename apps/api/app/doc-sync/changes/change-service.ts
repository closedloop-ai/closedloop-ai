import { ArtifactType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { DocSyncChangeCallback } from "@repo/realtime-contract/doc-sync-internal";

export const DOC_SYNC_CHANGE_RECEIVED_EVENT = "doc_sync.change_received";

/**
 * PLN-2200 T-7.8: doc-sync's change callbacks, once the caller and the
 * document are verified. `receive` is the extension point ISS-11216 and the
 * notification rules build on; it decides nothing yet (GAP-002).
 */
export const docSyncChangeService = { findDocumentId, receive };

async function findDocumentId({
  organizationId,
  slug,
}: {
  organizationId: string;
  slug: string;
}): Promise<string | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { organizationId, slug, type: ArtifactType.DOCUMENT },
      select: { id: true },
    })
  );
  return artifact?.id ?? null;
}

function receive({
  documentId,
  organizationId,
  change,
}: {
  documentId: string;
  organizationId: string;
  change: DocSyncChangeCallback;
}): Promise<void> {
  log.debug(DOC_SYNC_CHANGE_RECEIVED_EVENT, {
    event: DOC_SYNC_CHANGE_RECEIVED_EVENT,
    documentId,
    organizationId,
    callbackId: change.callbackId,
    sources: change.sources,
    editorCount: change.editorUserIds.length,
    mentionCount: change.mentions.length,
    mentionsTruncated: change.mentionsTruncated,
  });
  return Promise.resolve();
}
