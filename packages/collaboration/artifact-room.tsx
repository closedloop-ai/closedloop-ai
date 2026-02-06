"use client";

import { ClientSideSuspense, RoomProvider } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
import { CollaborationProvider } from "./collaboration-provider";
import type { UserInfo } from "./user-resolvers";

export type { UserInfo } from "./user-resolvers";

export type ArtifactRoomProps = {
  roomId: string;
  children: ReactNode;
  users?: UserInfo[];
};

/**
 * Wrapper component for artifact-specific collaborative editing.
 * Comments are visible to all organization members (no granular permissions).
 * Supports @mentions when users array is provided.
 */
export function ArtifactRoom({
  roomId,
  children,
  users = [],
}: Readonly<ArtifactRoomProps>) {
  return (
    <CollaborationProvider users={users}>
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
    </CollaborationProvider>
  );
}
