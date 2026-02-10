"use client";

import { ClientSideSuspense, RoomProvider } from "@liveblocks/react/suspense";
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
 */
export function ArtifactRoom({
  roomId,
  children,
}: Readonly<ArtifactRoomProps>) {
  // Uses RoomProvider directly instead of wrapping in CollaborationProvider (which
  // mounts a second LiveblocksProvider). Liveblocks throws on nested LiveblocksProvider
  // instances, but RoomProvider's internal wrapper uses allowNesting:true, so it
  // safely coexists with the top-level LiveblocksProvider mounted in the layout.
  return (
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
  );
}
