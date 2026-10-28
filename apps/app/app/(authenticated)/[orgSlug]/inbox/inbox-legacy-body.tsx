"use client";

import { ClientSideSuspense } from "@liveblocks/react/suspense";
import { useFeatureFlagsLoaded } from "@repo/analytics/client";
import {
  INBOX_NOTIFICATION_KINDS,
  InboxActorRowsContext,
} from "@repo/app/inbox/components/inbox-row-kinds";
import { withoutRetiredInboxNotificationKinds } from "@repo/app/inbox/lib/retired-inbox-notification-kinds";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  useInboxNotifications,
  useMarkAllInboxNotificationsAsRead,
  useUnreadInboxNotificationsCount,
} from "@repo/collaboration/client/hooks";
import {
  InboxNotification,
  InboxNotificationList,
} from "@repo/collaboration/client/inbox";
import { Button } from "@repo/design-system/components/ui/button";
import { CheckCheckIcon, InboxIcon } from "lucide-react";

/**
 * The Inbox composition that shipped before ISS-9406, kept as the closed-by-
 * default side of `inbox-complete-surface`.
 *
 * The rendered output is unchanged: the page used to be this file, and the host
 * above it now derives `isAvailable` once and hands it to whichever branch
 * renders. Nothing here knows the gate exists. The one non-cosmetic change is
 * that the row-kind table and the actor context are imported from
 * `@repo/app/inbox/components/inbox-row-kinds` — ONE table shared with the
 * complete surface, so the null-prototype hardening and the row identity cannot
 * differ by branch and an ISS-5010 follow-on cannot land on only one copy.
 */
export function InboxLegacyBody({ isAvailable }: { isAvailable: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      {isAvailable ? (
        <InboxWithSuspense />
      ) : (
        <InboxEmptyState
          description="Notifications are currently unavailable. Please try again later."
          title="Notifications unavailable"
        />
      )}
    </div>
  );
}

type InboxEmptyStateProps = {
  title: string;
  description: string;
};

function InboxEmptyState({ title, description }: InboxEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <InboxIcon className="h-12 w-12 text-muted-foreground" />
      <p className="text-muted-foreground">{title}</p>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

function InboxContent() {
  const { inboxNotifications: allNotifications } = useInboxNotifications();
  const inboxNotifications =
    withoutRetiredInboxNotificationKinds(allNotifications);
  const markAllAsRead = useMarkAllInboxNotificationsAsRead();
  const { count: unreadCount } = useUnreadInboxNotificationsCount();
  // Wait for PostHog: an unresolved flag reads as `false`, so deciding early
  // paints actor-less rows and rewrites every headline when flags land.
  const featureFlagsLoaded = useFeatureFlagsLoaded();
  const actorRowsFlagEnabled = useFeatureFlagEnabled(
    INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY
  );
  const actorRowsEnabled = featureFlagsLoaded && actorRowsFlagEnabled;

  if (inboxNotifications.length === 0) {
    return (
      <InboxEmptyState
        description="You'll see notifications here when someone mentions you or comments on your work."
        title="No notifications yet"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button
          disabled={unreadCount === 0}
          onClick={markAllAsRead}
          size="sm"
          variant="ghost"
        >
          <CheckCheckIcon className="h-4 w-4" />
          Mark all as read
        </Button>
      </div>
      <InboxActorRowsContext.Provider value={actorRowsEnabled}>
        <InboxNotificationList>
          {inboxNotifications.map((notification) => (
            <InboxNotification
              inboxNotification={notification}
              key={notification.id}
              kinds={INBOX_NOTIFICATION_KINDS}
            />
          ))}
        </InboxNotificationList>
      </InboxActorRowsContext.Provider>
    </div>
  );
}

function InboxWithSuspense() {
  return (
    <ClientSideSuspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground">Loading notifications...</p>
        </div>
      }
    >
      <InboxContent />
    </ClientSideSuspense>
  );
}
