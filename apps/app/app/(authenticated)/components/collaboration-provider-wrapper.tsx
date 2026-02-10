"use client";

import { LiveblocksAvailabilityContext } from "@repo/collaboration/liveblocks-error-boundary";
import { TopLevelCollaborationProvider } from "@repo/collaboration/top-level-collaboration-provider";
import type { ReactNode } from "react";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@/hooks/queries/use-users";

const LIVEBLOCKS_UNAVAILABLE = { isAvailable: false };

type CollaborationProviderWrapperProps = {
  children: ReactNode;
};

/**
 * Client component wrapper that fetches user data and mounts TopLevelCollaborationProvider.
 * Must be client-side because TopLevelCollaborationProvider is a client component
 * and needs to fetch organization context.
 *
 * While user data loads, provides LiveblocksAvailabilityContext with isAvailable=false
 * to prevent inbox hooks from executing outside the LiveblocksProvider.
 */
export function CollaborationProviderWrapper({
  children,
}: Readonly<CollaborationProviderWrapperProps>) {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const { data: users = [] } = useOrganizationUsers();

  // While loading, mark Liveblocks as unavailable so inbox hooks don't run
  // outside the provider. InboxBadge and inbox page check this context.
  if (isUserLoading || !currentUser) {
    return (
      <LiveblocksAvailabilityContext.Provider value={LIVEBLOCKS_UNAVAILABLE}>
        {children}
      </LiveblocksAvailabilityContext.Provider>
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
      organizationId={currentUser.organizationId}
      users={userInfo}
    >
      {children}
    </TopLevelCollaborationProvider>
  );
}
