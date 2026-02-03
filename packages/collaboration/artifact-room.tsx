"use client";

import {
  ClientSideSuspense,
  LiveblocksProvider,
  RoomProvider,
} from "@liveblocks/react/suspense";
import type { ReactNode } from "react";

export type ArtifactRoomProps = {
  roomId: string;
  children: ReactNode;
};

/**
 * Wrapper component for artifact-specific collaborative editing.
 * Comments are visible to all organization members (no granular permissions).
 */
export function ArtifactRoom({
  roomId,
  children,
}: Readonly<ArtifactRoomProps>) {
  return (
    <LiveblocksProvider authEndpoint={"/api/collaboration/auth"}>
      <RoomProvider
        id={roomId}
        initialPresence={{ cursor: null, selection: null }}
      >
        <ClientSideSuspense fallback={null}>{children}</ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  );
}
