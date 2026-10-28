"use client";

import { useEventListener } from "@liveblocks/react";
import type { DocumentDetail } from "@repo/api/src/types/document";
// Loads the `Liveblocks` global type augmentation (RoomEvent, etc.) into this
// package's program so `Liveblocks["RoomEvent"]` resolves; @repo/app has no
// other importer of it.
import "@repo/collaboration/shared/config";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { useCallback } from "react";
import { useRefetchPublishedDocument } from "./use-refetch-published-document";

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
 * room, the Liveblocks reset protocol, and reacts by refetching the document
 * and notifying the caller. The `version.published` realtime signal
 * (`useDocumentVersionSignals`) tells editors on both transports.
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
 * enforced downstream: `useRemoteVersionPublished` bails when the refetched
 * version is not newer than the version it is already showing, so the tab that
 * published via its own mutation does no redundant reseed, and a version that
 * arrives as both the room event and the signal acts once.
 */
export function useDocumentRoomEvents({
  documentId,
  onRemoteVersionPublished,
}: UseDocumentRoomEventsConfig) {
  const refetch = useRefetchPublishedDocument(
    documentId,
    onRemoteVersionPublished
  );

  const handleEvent = useCallback(
    async ({ event }: { event: Liveblocks["RoomEvent"] }) => {
      if (event.type !== RoomEventType.DocumentVersionPublished) {
        return;
      }
      await refetch();
    },
    [refetch]
  );

  useEventListener(handleEvent);
}
