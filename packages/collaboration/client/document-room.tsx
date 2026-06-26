"use client";

import { RoomProvider, useUpdateMyPresence } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
import { useEffect } from "react";

export type { UserInfo } from "./user-resolvers";

export type DocumentRoomProps = {
  roomId: string;
  children: ReactNode;
  /**
   * Marks this connection as a read-only viewer (e.g. someone viewing a
   * historical artifact version). The connection still joins the room so
   * the Feed sidebar's `useThreads()` works, but `<Presence>` /
   * `<InlinePresence>` filter out these connections from the avatar stack
   * shown to live editors.
   */
  readOnly?: boolean;
};

/**
 * Wrapper component for document-specific collaborative editing.
 * Uses RoomProvider directly — the top-level LiveblocksProvider (from layout)
 * already configures the Liveblocks client, resolveUsers, and resolveMentionSuggestions.
 * RoomProvider inherits the client context and adds room-scoped features (comments, presence).
 *
 * Children render immediately — suspending hooks (useThreads, useOthers, etc.)
 * should be wrapped in their own Suspense boundaries closer to where they're used.
 */
export function DocumentRoom({
  roomId,
  children,
  readOnly = false,
}: Readonly<DocumentRoomProps>) {
  return (
    <RoomProvider id={roomId} initialPresence={{ readOnly }}>
      <ReadOnlyPresenceSync readOnly={readOnly} />
      {children}
    </RoomProvider>
  );
}

/**
 * `RoomProvider#initialPresence` is only evaluated once at mount, so the
 * `readOnly` flag would otherwise go stale if the same room stays mounted
 * across a version switch (the typical case — `feedRoomId` is keyed by
 * artifact slug, not version). This effect republishes the current value
 * whenever the prop flips so live editors and read-only viewers transition
 * in both directions are reflected in the presence avatar stack.
 */
function ReadOnlyPresenceSync({ readOnly }: { readOnly: boolean }) {
  const updateMyPresence = useUpdateMyPresence();
  useEffect(() => {
    updateMyPresence({ readOnly });
  }, [readOnly, updateMyPresence]);
  return null;
}
