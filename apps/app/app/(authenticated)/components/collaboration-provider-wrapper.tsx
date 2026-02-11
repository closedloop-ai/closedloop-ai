"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import {
  LiveblocksAvailabilityContext,
  LiveblocksErrorBoundary,
} from "@repo/collaboration/liveblocks-error-boundary";
import { TopLevelCollaborationProvider } from "@repo/collaboration/top-level-collaboration-provider";
import { type ReactNode, useMemo } from "react";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@/hooks/queries/use-users";
import { createResolveRoomsInfo } from "@/lib/room-resolvers";

const LIVEBLOCKS_UNAVAILABLE = { isAvailable: false };

type CollaborationProviderWrapperProps = {
  children: ReactNode;
};

/**
 * Client component wrapper that fetches user data and mounts TopLevelCollaborationProvider.
 * Must be client-side because TopLevelCollaborationProvider is a client component
 * and needs to fetch organization context.
 *
 * While user data loads, mounts a minimal LiveblocksProvider (auth endpoint only)
 * so that RoomProvider in editor pages doesn't throw if artifact data resolves
 * before /me. LiveblocksErrorBoundary catches auth errors during bootstrap;
 * inbox hooks are still gated by isAvailable=false.
 */
export function CollaborationProviderWrapper({
  children,
}: Readonly<CollaborationProviderWrapperProps>) {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const { data: users = [] } = useOrganizationUsers();

  // Type assertion is necessary because TypeScript can't verify the RoomInfo type
  // matches the global Liveblocks interface across module boundaries
  const organizationId = currentUser?.organizationId;
  const resolveRoomsInfo = useMemo(
    () =>
      organizationId
        ? (createResolveRoomsInfo(organizationId) as Parameters<
            typeof LiveblocksProvider
          >[0]["resolveRoomsInfo"])
        : undefined,
    [organizationId]
  );

  // While loading, mount a minimal LiveblocksProvider so RoomProvider descendants
  // have context. Error boundary catches auth failures; isAvailable=false gates
  // inbox hooks until full provider mounts.
  if (isUserLoading || !currentUser) {
    return (
      <LiveblocksProvider authEndpoint="/api/collaboration/auth">
        <LiveblocksErrorBoundary>
          <LiveblocksAvailabilityContext.Provider
            value={LIVEBLOCKS_UNAVAILABLE}
          >
            {children}
          </LiveblocksAvailabilityContext.Provider>
        </LiveblocksErrorBoundary>
      </LiveblocksProvider>
    );
  }

  // Transform User[] to UserInfo[] format expected by collaboration provider
  const userInfo = users.map((user) => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    active: user.active,
  }));

  return (
    <TopLevelCollaborationProvider
      resolveRoomsInfo={resolveRoomsInfo}
      users={userInfo}
    >
      {children}
    </TopLevelCollaborationProvider>
  );
}
