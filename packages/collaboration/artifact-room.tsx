"use client";

import { RoomProvider } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";

export type { UserInfo } from "./user-resolvers";

export type ArtifactRoomProps = {
  roomId: string;
  children: ReactNode;
};

/**
 * Wrapper component for artifact-specific collaborative editing.
 * Uses RoomProvider directly — the top-level LiveblocksProvider (from layout)
 * already configures the Liveblocks client, resolveUsers, and resolveMentionSuggestions.
 * RoomProvider inherits the client context and adds room-scoped features (comments, presence).
 *
 * Children render immediately — suspending hooks (useThreads, useOthers, etc.)
 * should be wrapped in their own Suspense boundaries closer to where they're used.
 */
export function ArtifactRoom({
  roomId,
  children,
}: Readonly<ArtifactRoomProps>) {
  return (
    <RoomProvider
      id={roomId}
      initialPresence={{ cursor: null, selection: null }}
    >
      {children}
    </RoomProvider>
  );
}
