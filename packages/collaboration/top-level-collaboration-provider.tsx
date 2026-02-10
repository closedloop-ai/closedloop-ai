"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
import { LiveblocksErrorBoundary } from "./liveblocks-error-boundary";
import { createResolveRoomsInfo } from "./room-resolvers";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
  type UserInfo,
} from "./user-resolvers";

export type TopLevelCollaborationProviderProps = {
  children: ReactNode;
  organizationId: string;
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
  organizationId,
  users = [],
}: Readonly<TopLevelCollaborationProviderProps>) {
  // Type assertion is necessary because TypeScript can't verify the RoomInfo type
  // matches the global Liveblocks interface across module boundaries
  const resolveRoomsInfo = createResolveRoomsInfo(organizationId) as Parameters<
    typeof LiveblocksProvider
  >[0]["resolveRoomsInfo"];

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
