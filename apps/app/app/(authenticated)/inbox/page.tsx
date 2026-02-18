"use client";

import { ClientSideSuspense } from "@liveblocks/react/suspense";
import {
  InboxNotification,
  InboxNotificationList,
  useLiveblocksAvailability,
} from "@repo/collaboration";
import { useInboxNotifications } from "@repo/collaboration/hooks";
import { parseArtifactRoomId } from "@repo/collaboration/room-utils";
import { Separator } from "@repo/design-system/components/ui/separator";
import { InboxIcon } from "lucide-react";
import type React from "react";

type InboxNotificationKinds = React.ComponentProps<
  typeof InboxNotification
>["kinds"];

type InboxEmptyStateProps = {
  title: string;
  description: string;
};

function resolveArtifactHref(roomId: string, href?: string): string {
  if (href) {
    return href;
  }
  try {
    const { slug } = parseArtifactRoomId(roomId);
    return `/artifacts/${slug}`;
  } catch {
    return "/inbox";
  }
}

const inboxNotificationKinds: InboxNotificationKinds = {
  thread: ({ inboxNotification, href, ...props }) => (
    <InboxNotification.Thread
      {...props}
      href={resolveArtifactHref(inboxNotification.roomId, href)}
      inboxNotification={inboxNotification}
    />
  ),
  textMention: ({ inboxNotification, href, ...props }) => (
    <InboxNotification.TextMention
      {...props}
      href={resolveArtifactHref(inboxNotification.roomId, href)}
      inboxNotification={inboxNotification}
    />
  ),
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

  if (inboxNotifications.length === 0) {
    return (
      <InboxEmptyState
        description="You'll see notifications here when someone mentions you or comments on your work."
        title="No notifications yet"
      />
    );
  }

  return (
    <InboxNotificationList>
      {inboxNotifications.map((notification) => (
        <InboxNotification
          inboxNotification={notification}
          key={notification.id}
          kinds={inboxNotificationKinds}
        />
      ))}
    </InboxNotificationList>
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
        <h1 className="font-semibold text-2xl tracking-tight">Inbox</h1>
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
          title="Inbox unavailable"
        />
      )}
    </div>
  );
}
