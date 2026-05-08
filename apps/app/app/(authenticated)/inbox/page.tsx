"use client";

import { ClientSideSuspense } from "@liveblocks/react/suspense";
import {
  InboxNotification,
  InboxNotificationList,
  useLiveblocksAvailability,
} from "@repo/collaboration";
import { AssignmentNotification } from "@repo/collaboration/assignment-notification";
import {
  useInboxNotifications,
  useMarkAllInboxNotificationsAsRead,
  useUnreadInboxNotificationsCount,
} from "@repo/collaboration/hooks";
import { Button } from "@repo/design-system/components/ui/button";
import { Separator } from "@repo/design-system/components/ui/separator";
import { CheckCheckIcon, InboxIcon } from "lucide-react";

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
  const { inboxNotifications } = useInboxNotifications();
  const markAllAsRead = useMarkAllInboxNotificationsAsRead();
  const { count: unreadCount } = useUnreadInboxNotificationsCount();

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
      <InboxNotificationList>
        {inboxNotifications.map((notification) => (
          <InboxNotification
            inboxNotification={notification}
            key={notification.id}
            kinds={{
              $assignment: AssignmentNotification,
            }}
          />
        ))}
      </InboxNotificationList>
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

export default function InboxPage() {
  const { isAvailable } = useLiveblocksAvailability();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Notifications</h1>
        <p className="text-muted-foreground">
          View and manage your notifications.
        </p>
      </div>

      <Separator />

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
