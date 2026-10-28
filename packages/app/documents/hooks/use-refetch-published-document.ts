"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { invalidateDocumentDetailCaches, useDocument } from "./use-documents";

/**
 * Refetches the document after another client published a version, and hands
 * the result to `onRemoteVersionPublished`. Shared by the Liveblocks room
 * event and the `version.published` realtime signal.
 *
 * Refetching goes through `useDocument(..., { enabled: false }).refetch()`
 * rather than a hand-rolled `fetchQuery`: it reuses the canonical queryFn
 * defined in `use-documents.ts` and `refetch()` always hits the network,
 * sidestepping the global `staleTime: 60s` that would otherwise hand back
 * stale pre-publish content.
 */
export function useRefetchPublishedDocument(
  documentId: string,
  onRemoteVersionPublished: (updated: DocumentDetail) => void
): () => Promise<void> {
  const queryClient = useQueryClient();
  // Passive observer: enabled:false means this hook never triggers the
  // initial fetch (the parent page's useDocument already does that).
  const { refetch: refetchDocument } = useDocument(documentId, undefined, {
    enabled: false,
  });

  return useCallback(async () => {
    const result = await refetchDocument();
    if (!result.data) {
      return;
    }
    invalidateDocumentDetailCaches(queryClient, documentId, result.data.slug);
    onRemoteVersionPublished(result.data);
  }, [documentId, onRemoteVersionPublished, queryClient, refetchDocument]);
}
