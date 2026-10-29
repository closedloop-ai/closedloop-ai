"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
// Loads the `Liveblocks` global type augmentation (RoomInfo, etc.) so this
// provider is self-sufficient (no longer relies on the deleted index barrel or
// the web shell's liveblocks.config.ts side-effect).
import "../shared/config";
import type { AuthEndpoint } from "./collaboration-provider";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
  type UserInfo,
} from "./user-resolvers";

export type RoomInfo = Liveblocks["RoomInfo"];

export type TopLevelCollaborationProviderProps = {
  children: ReactNode;
  authEndpoint: AuthEndpoint;
  resolveRoomsInfo?: (args: {
    roomIds: string[];
  }) => Promise<(RoomInfo | undefined)[]>;
  users?: UserInfo[];
};

/**
 * Top-level Liveblocks provider for global collaboration features (inbox, notifications).
 * Wraps only LiveblocksProvider without RoomProvider - individual rooms are handled separately.
 * Uses dual-mode auth endpoint that issues global tokens for accessing inbox data.
 * Mounts no error boundary of its own: children here are the whole authenticated
 * shell, and a boundary at that height swallows every render failure under it
 * (ISS-10202). Each Liveblocks-dependent surface brings its own
 * `LiveblocksErrorBoundary`, so `useLiveblocksAvailability()` reflects a real
 * Liveblocks failure without hiding anything else.
 */
export function TopLevelCollaborationProvider({
  children,
  authEndpoint,
  resolveRoomsInfo,
  users = [],
}: Readonly<TopLevelCollaborationProviderProps>) {
  return (
    <LiveblocksProvider
      authEndpoint={authEndpoint}
      resolveMentionSuggestions={createResolveMentionSuggestions(users)}
      resolveRoomsInfo={resolveRoomsInfo}
      resolveUsers={createResolveUsers(users)}
    >
      {children}
    </LiveblocksProvider>
  );
}
