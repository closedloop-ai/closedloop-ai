"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
import { LiveblocksErrorBoundary } from "./liveblocks-error-boundary";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
  type UserInfo,
} from "./user-resolvers";

export type RoomInfo = Liveblocks["RoomInfo"];

export type TopLevelCollaborationProviderProps = {
  children: ReactNode;
  resolveRoomsInfo?: (args: {
    roomIds: string[];
  }) => Promise<(RoomInfo | undefined)[]>;
  users?: UserInfo[];
};

/**
 * Top-level Liveblocks provider for global collaboration features (inbox, notifications).
 * Wraps only LiveblocksProvider without RoomProvider - individual rooms are handled separately.
 * Uses dual-mode auth endpoint that issues global tokens for accessing inbox data.
 * LiveblocksErrorBoundary wraps children so that useLiveblocksAvailability() reflects
 * actual Liveblocks errors (auth failures, network issues) instead of always returning true.
 */
export function TopLevelCollaborationProvider({
  children,
  resolveRoomsInfo,
  users = [],
}: Readonly<TopLevelCollaborationProviderProps>) {
  return (
    <LiveblocksProvider
      authEndpoint="/api/collaboration/auth"
      resolveMentionSuggestions={createResolveMentionSuggestions(users)}
      resolveRoomsInfo={resolveRoomsInfo}
      resolveUsers={createResolveUsers(users)}
    >
      <LiveblocksErrorBoundary>{children}</LiveblocksErrorBoundary>
    </LiveblocksProvider>
  );
}
