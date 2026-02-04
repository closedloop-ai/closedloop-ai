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
        <ClientSideSuspense
          fallback={
            <div className="flex flex-1 px-6 py-8 text-muted-foreground text-sm">
              Loading collaborative editor…
            </div>
          }
        >
          {children}
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  );
}
