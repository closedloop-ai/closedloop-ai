"use client";

import { useEventListener } from "@liveblocks/react";
import type { DocumentDetail } from "@repo/api/src/types/document";
// Loads the `Liveblocks` global type augmentation (RoomEvent, etc.) into this
// package's program so `Liveblocks["RoomEvent"]` resolves; @repo/app has no
// other importer of it.
import "@repo/collaboration/shared/config";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { invalidateDocumentDetailCaches, useDocument } from "./use-documents";

type UseDocumentRoomEventsConfig = {
  documentId: string;
  /**
   * Invoked after a `document-version-published` broadcast, with the freshly
   * refetched `DocumentDetail`. The scaffold passes a callback that decides
   * whether to advance the user to the new version and reseed the editor
   * (e.g. only when they were viewing the previous latest, and bailing when
   * the refetched version is not newer than what is already shown).
   */
  onRemoteVersionPublished: (updated: DocumentDetail) => void;
};

/**
 * Listens for `document-version-published` events on the current Liveblocks
 * room and reacts by refetching the document and notifying the caller.
 *
 * Must be mounted inside a Liveblocks `RoomProvider` — call sites should
 * gate the component that invokes this hook on the presence of a room ID
 * (see `<DocumentRoomEventListener>` in the editor scaffold).
 *
 * Every connected client reacts to the event, including the publisher. We do
 * NOT dedupe on `event.publisherId`: that field is the publishing user's id,
 * which is too coarse to identify the originating client. A headless process
 * acting as the user (e.g. an MCP agent creating a version) shares the user's
 * id but is a different client that never ran the browser's mutation
 * `onSuccess`, so a `publisherId === currentUser` filter would wrongly
 * suppress the reload in that user's open editor. Idempotency is instead
 * enforced downstream: the scaffold's `onRemoteVersionPublished` bails when
 * the refetched version is not newer than the version it is already showing,
 * so the tab that published via its own mutation does no redundant reseed.
 *
 * Refetching goes through `useDocument(..., { enabled: false }).refetch()`
 * rather than a hand-rolled `fetchQuery`: it reuses the canonical queryFn
 * defined in `use-documents.ts` and `refetch()` always hits the network,
 * sidestepping the global `staleTime: 60s` that would otherwise hand back
 * stale pre-publish content.
 */
export function useDocumentRoomEvents({
  documentId,
  onRemoteVersionPublished,
}: UseDocumentRoomEventsConfig) {
  const queryClient = useQueryClient();
  // Passive observer — enabled:false means this hook never triggers the
  // initial fetch (the parent page's useDocument already does that).
  // It exists solely so we can call .refetch() to force a network read.
  const { refetch: refetchDocument } = useDocument(documentId, undefined, {
    enabled: false,
  });

  const handleEvent = useCallback(
    async ({ event }: { event: Liveblocks["RoomEvent"] }) => {
      if (event.type !== RoomEventType.DocumentVersionPublished) {
        return;
      }

      const result = await refetchDocument();
      if (!result.data) {
        return;
      }
      invalidateDocumentDetailCaches(queryClient, documentId, result.data.slug);
      onRemoteVersionPublished(result.data);
    },
    [documentId, onRemoteVersionPublished, queryClient, refetchDocument]
  );

  useEventListener(handleEvent);
}
