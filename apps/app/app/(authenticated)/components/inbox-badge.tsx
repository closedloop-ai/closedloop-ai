"use client";

import { ClientSideSuspense } from "@liveblocks/react/suspense";
import { useUnreadInboxNotificationsCount } from "@repo/collaboration/hooks";
import { useLiveblocksAvailability } from "@repo/collaboration/liveblocks-error-boundary";
import { SidebarCountBadge } from "./sidebar-count-badge";

function InboxBadgeContent() {
  const { count } = useUnreadInboxNotificationsCount();

  if (count === 0) {
    return null;
  }

  return <SidebarCountBadge count={count} />;
}

/**
 * Dynamic badge component for the Inbox sidebar item.
 * Shows unread notification count from Liveblocks inbox.
 * Only renders when Liveblocks is available and count > 0.
 */
export function InboxBadge() {
  const { isAvailable } = useLiveblocksAvailability();

  // If Liveblocks is not available (error occurred), don't render badge
  if (!isAvailable) {
    return null;
  }

  return (
    <ClientSideSuspense
      fallback={
        <span className="ml-auto text-[10px] text-muted-foreground">...</span>
      }
    >
      <InboxBadgeContent />
    </ClientSideSuspense>
  );
}
