"use client";

import { ApiError } from "@repo/app/shared/api/api-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { createResolveRoomsInfo } from "@repo/app/shared/lib/room-resolvers";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@repo/app/users/hooks/use-users";
import type { AuthEndpoint } from "@repo/collaboration/client/collaboration-provider";
import { DocSyncConfigContext } from "@repo/collaboration/client/doc-sync-config";
import { LiveblocksAvailabilityContext } from "@repo/collaboration/client/liveblocks-error-boundary";
import {
  type RoomInfo,
  TopLevelCollaborationProvider,
} from "@repo/collaboration/client/top-level-collaboration-provider";
import { parseDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import {
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDocSyncConfig } from "../hooks/use-doc-sync-config";

const LIVEBLOCKS_UNAVAILABLE = { isAvailable: false };
const LIVEBLOCKS_AVAILABLE = { isAvailable: true };

type CollaborationProviderWrapperProps = {
  children: ReactNode;
};

/**
 * Client component wrapper that fetches user data and mounts TopLevelCollaborationProvider.
 * Must be client-side because TopLevelCollaborationProvider is a client component
 * and needs to fetch organization context.
 *
 * The provider chain is the same element tree before and after `/me` resolves;
 * only prop values change. `children` is the whole authenticated shell, so a
 * different root element per state remounted every descendant once per page
 * load (ISS-10464). Inbox hooks stay gated by `isAvailable=false` until the
 * user resolves.
 *
 * No error boundary here: `children` is the whole authenticated shell, and a
 * boundary at this height caught every render failure under it and re-rendered
 * the same subtree, so the route's `error.tsx` never saw one (ISS-10202).
 */
export function CollaborationProviderWrapper({
  children,
}: Readonly<CollaborationProviderWrapperProps>) {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const { data: users = [] } = useOrganizationUsers();
  const apiClient = useApiClient();
  const organizationId = currentUser?.organizationId;

  // Liveblocks room auth goes through apps/api (FEA-1510), reusing the same
  // transport (origin + bearer token) as every other BFF call, so the same
  // provider works on the desktop renderer. The route returns the raw
  // Liveblocks `{ token }` body, which `postRaw` parses and the provider's
  // auth callback consumes directly.
  //
  // Built once and read through a ref (tamsinb, PR #7741): Liveblocks swaps
  // in a new callback from a passive effect, which runs AFTER the inbox's and
  // a room's own effects have already called the old one on the commit where
  // `/me` lands. A layout effect runs before either of them.
  const latest = useRef({ apiClient, organizationId });
  useLayoutEffect(() => {
    latest.current = { apiClient, organizationId };
  }, [apiClient, organizationId]);
  const [authEndpoint] = useState(() =>
    createCollaborationAuthEndpoint(
      (room) =>
        latest.current.apiClient.postRaw<{ token: string }>(
          "/collaboration/auth",
          { room }
        ),
      () => latest.current.organizationId
    )
  );

  // Always a function: LiveblocksProvider freezes a resolver option that is
  // absent on its first render, and that render now happens before `/me`.
  const resolveRoomsInfo = useMemo(
    () =>
      organizationId
        ? createResolveRoomsInfo(organizationId)
        : resolveNoRoomsInfo,
    [organizationId]
  );

  // Transform User[] to UserInfo[] format expected by collaboration provider
  const userInfo = users.map((user) => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    active: user.active,
  }));

  const availability =
    isUserLoading || !currentUser
      ? LIVEBLOCKS_UNAVAILABLE
      : LIVEBLOCKS_AVAILABLE;

  const docSyncConfig = useDocSyncConfig();

  return (
    <TopLevelCollaborationProvider
      authEndpoint={authEndpoint}
      resolveRoomsInfo={resolveRoomsInfo}
      users={userInfo}
    >
      <LiveblocksAvailabilityContext.Provider value={availability}>
        <DocSyncConfigContext.Provider value={docSyncConfig}>
          {children}
        </DocSyncConfigContext.Provider>
      </LiveblocksAvailabilityContext.Provider>
    </TopLevelCollaborationProvider>
  );
}

type AuthCallback = Extract<AuthEndpoint, (room?: string) => unknown>;
type AuthResult = Awaited<ReturnType<AuthCallback>>;

/**
 * `/collaboration/auth` mints the same org-wide token whatever room is asked
 * for, so a request for the inbox and one for a room in the caller's own
 * organization share one in-flight call; Liveblocks' own dedupe is per room.
 * The shared call names no room, so one room's refusal cannot become the
 * inbox's answer (marisolashgrove, PR #7741). A room in any other organization
 * still goes to the server, which refuses it. Nothing is kept once the call
 * settles, so a re-auth always gets a new token.
 */
function createCollaborationAuthEndpoint(
  requestToken: (room?: string) => Promise<{ token: string }>,
  currentOrganizationId: () => string | undefined
): AuthCallback {
  let shared: Promise<AuthResult> | undefined;
  const authorize = (room?: string): Promise<AuthResult> =>
    requestToken(room)
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
      });

  return (room?: string) => {
    if (!isCoveredByOrganizationToken(room, currentOrganizationId())) {
      return authorize(room);
    }
    shared ??= authorize().finally(() => {
      shared = undefined;
    });
    return shared;
  };
}

function isCoveredByOrganizationToken(
  room: string | undefined,
  organizationId: string | undefined
): boolean {
  if (!organizationId) {
    return false;
  }
  if (room === undefined) {
    return true;
  }
  try {
    return parseDocumentRoomId(room).organizationId === organizationId;
  } catch {
    return false;
  }
}

/**
 * Liveblocks caches this miss for the life of the page, which is safe only
 * because nothing asks for room info before `/me`: its sole consumer, the
 * inbox's notification rows, is held off by `isAvailable`.
 */
function resolveNoRoomsInfo({
  roomIds,
}: {
  roomIds: string[];
}): Promise<(RoomInfo | undefined)[]> {
  return Promise.resolve(roomIds.map(() => undefined));
}
