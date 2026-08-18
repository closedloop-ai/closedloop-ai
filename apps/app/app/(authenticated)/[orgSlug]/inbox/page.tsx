"use client";

import { ClientSideSuspense } from "@liveblocks/react/suspense";
import { useFeatureFlag, useFeatureFlagsLoaded } from "@repo/analytics/client";
import type { AssignmentNotificationProps } from "@repo/collaboration/client/assignment-notification";
import { AssignmentNotification } from "@repo/collaboration/client/assignment-notification";
import { AwaitingInputNotification } from "@repo/collaboration/client/awaiting-input-notification";
import {
  useInboxNotifications,
  useMarkAllInboxNotificationsAsRead,
  useUnreadInboxNotificationsCount,
} from "@repo/collaboration/client/hooks";
import {
  InboxNotification,
  InboxNotificationList,
} from "@repo/collaboration/client/inbox";
import { useLiveblocksAvailability } from "@repo/collaboration/client/liveblocks-error-boundary";
import { LoopCompletedNotification } from "@repo/collaboration/client/loop-completed-notification";
import type { MentionNotificationProps } from "@repo/collaboration/client/mention-notification";
import { MentionNotification } from "@repo/collaboration/client/mention-notification";
import { Button } from "@repo/design-system/components/ui/button";
import { CheckCheckIcon, InboxIcon } from "lucide-react";
import { createContext, useContext } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY } from "@/lib/inbox-notification-flags";

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

/**
 * ISS-5010: whether the actor treatment is on, carried to the row components as
 * context rather than as a choice between two components.
 *
 * The `kinds` map is a map of component TYPES, so selecting a different
 * component once PostHog answers unmounts and remounts every affected row.
 * Passing the flag through one stable type instead means the flag landing is an
 * ordinary re-render. Reading it once here also matters: `useFeatureFlag` falls
 * through to a localStorage read and JSON parse while a flag is unresolved, and
 * a list re-reading that per row would pay it once per notification.
 */
const InboxActorRowsContext = createContext(false);

function AssignmentNotificationRow(props: AssignmentNotificationProps) {
  const showActor = useContext(InboxActorRowsContext);
  return <AssignmentNotification {...props} showActor={showActor} />;
}

function MentionNotificationRow(props: MentionNotificationProps) {
  const showActor = useContext(InboxActorRowsContext);
  return <MentionNotification {...props} showActor={showActor} />;
}

/**
 * One frozen map, so neither its identity nor the component types inside it
 * change across a render or a flag transition.
 */
const INBOX_NOTIFICATION_KINDS = {
  $assignment: AssignmentNotificationRow,
  $awaitingInput: AwaitingInputNotification,
  $loopCompleted: LoopCompletedNotification,
  $mention: MentionNotificationRow,
};

function InboxContent() {
  const { inboxNotifications } = useInboxNotifications();
  const markAllAsRead = useMarkAllInboxNotificationsAsRead();
  const { count: unreadCount } = useUnreadInboxNotificationsCount();
  // Wait for PostHog to answer before turning the treatment on. An unresolved
  // flag reads as `false`, so deciding early would paint the actor-less rows
  // and then rewrite every headline the moment flags land.
  const featureFlagsLoaded = useFeatureFlagsLoaded();
  const actorRowsFlag = useFeatureFlag(
    INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY
  );
  const actorRowsEnabled =
    featureFlagsLoaded && actorRowsFlag?.enabled === true;

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

export default function InboxPage() {
  const { isAvailable } = useLiveblocksAvailability();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Inbox" }]} />
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
    </div>
  );
}
