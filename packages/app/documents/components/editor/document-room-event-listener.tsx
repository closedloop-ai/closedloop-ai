"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { useDocumentRoomEvents } from "@repo/app/documents/hooks/use-document-room-events";

type DocumentRoomEventListenerProps = {
  documentId: string;
  onRemoteVersionPublished: (updated: DocumentDetail) => void;
};

/**
 * Invisible component that subscribes the current Liveblocks room to
 * server-broadcast events. Must be rendered inside a RoomProvider — the
 * scaffold mounts it only when a `liveblocksRoomId` is available.
 */
export function DocumentRoomEventListener({
  documentId,
  onRemoteVersionPublished,
}: Readonly<DocumentRoomEventListenerProps>) {
  useDocumentRoomEvents({ documentId, onRemoteVersionPublished });
  return null;
}
