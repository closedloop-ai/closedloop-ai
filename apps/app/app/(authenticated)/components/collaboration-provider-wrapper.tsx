"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { createResolveRoomsInfo } from "@repo/app/shared/lib/room-resolvers";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@repo/app/users/hooks/use-users";
import type { AuthEndpoint } from "@repo/collaboration/client/collaboration-provider";
import {
  LiveblocksAvailabilityContext,
  LiveblocksErrorBoundary,
} from "@repo/collaboration/client/liveblocks-error-boundary";
import { TopLevelCollaborationProvider } from "@repo/collaboration/client/top-level-collaboration-provider";
import { type ReactNode, useMemo } from "react";

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
  const apiClient = useApiClient();

  // Liveblocks room auth goes through apps/api (FEA-1510), reusing the same
  // transport (origin + bearer token) as every other BFF call, so the same
  // provider works on the desktop renderer. The route returns the raw
  // Liveblocks `{ token }` body, which `postRaw` parses and the provider's
  // auth callback consumes directly.
  const authEndpoint = useMemo<AuthEndpoint>(
    () => (room?: string) =>
      apiClient
        .postRaw<{ token: string }>("/collaboration/auth", { room })
        // Liveblocks' auth callback contract expects an auth-failure to resolve
        // to `{ error }`, not throw. `postRaw` throws ApiError on 401/403, so
        // translate those; rethrow anything else as a genuine transport error.
        .catch((error) => {
          if (
            error instanceof ApiError &&
            (error.status === 401 || error.status === 403)
          ) {
            return {
              error: "forbidden" as const,
              reason: "Not authorized for this Liveblocks room",
            };
          }
          return Promise.reject(error);
        }),
    [apiClient]
  );

  const organizationId = currentUser?.organizationId;
  const resolveRoomsInfo = useMemo(
    () => (organizationId ? createResolveRoomsInfo(organizationId) : undefined),
    [organizationId]
  );

  // While loading, mount a minimal LiveblocksProvider so RoomProvider descendants
  // have context. Error boundary catches auth failures; isAvailable=false gates
  // inbox hooks until full provider mounts.
  if (isUserLoading || !currentUser) {
    return (
      <LiveblocksProvider authEndpoint={authEndpoint}>
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
      authEndpoint={authEndpoint}
      resolveRoomsInfo={resolveRoomsInfo}
      users={userInfo}
    >
      {children}
    </TopLevelCollaborationProvider>
  );
}
