import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { DocumentVersionSignalType } from "@repo/realtime-contract/signals";
import { emitSignal } from "@repo/realtime-server/emit-signal";

export type PublishedVersion = {
  organizationId: string;
  documentId: string;
  version: number;
};

/**
 * PLN-2190 T-2.5: tells open editors a version was published, on the
 * document's `document-versions` channel. Emitted on the database client,
 * not inside the version's transaction: that would deliver at commit, before
 * the live document holds the version. Never throws; a failure is logged.
 */
export async function emitDocumentVersionPublished({
  organizationId,
  documentId,
  version,
}: PublishedVersion): Promise<void> {
  try {
    const channel = formatChannelAddress(
      ChannelKind.DocumentVersions,
      organizationId,
      [documentId]
    );
    await withDb((db) =>
      emitSignal(db, channel, {
        type: DocumentVersionSignalType.Published,
        data: { version },
      })
    );
  } catch {
    log.error("Document version signal failed", {
      event: DOCUMENT_VERSION_SIGNAL_FAILED_EVENT,
      documentId,
      organizationId,
      version,
    });
  }
}

export const DOCUMENT_VERSION_SIGNAL_FAILED_EVENT =
  "document_version.signal_failed";
