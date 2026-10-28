"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { SignalTypes } from "@repo/realtime-contract/signals";
import { useSignals } from "../../shared/realtime/use-signals";
import { useRefetchPublishedDocument } from "./use-refetch-published-document";

type UseDocumentVersionSignalsConfig = {
  document: Pick<DocumentDetail, "id" | "organizationId">;
  /** The scaffold's `handleRemoteVersionPublished`, which acts on a version once. */
  onRemoteVersionPublished: (updated: DocumentDetail) => void;
};

/**
 * PLN-2190 T-3.4: listens for `version.published` on the document's
 * `document-versions` channel, on both transports, and refetches the
 * document. A resync (a reconnect, or a gap the service reports) refetches
 * too, so a signal missed while offline still advances the editor. With no
 * realtime client mounted it joins nothing.
 */
export function useDocumentVersionSignals({
  document,
  onRemoteVersionPublished,
}: UseDocumentVersionSignalsConfig): void {
  const refetch = useRefetchPublishedDocument(
    document.id,
    onRemoteVersionPublished
  );
  useSignals(versionsChannel(document.organizationId, document.id), {
    types: SignalTypes[ChannelKind.DocumentVersions],
    onSignal: () => {
      refetch();
    },
    onResync: () => {
      refetch();
    },
  });
}

function versionsChannel(
  organizationId: string,
  documentId: string
): string | null {
  try {
    return formatChannelAddress(ChannelKind.DocumentVersions, organizationId, [
      documentId,
    ]);
  } catch {
    return null;
  }
}
