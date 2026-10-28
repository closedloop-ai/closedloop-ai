"use client";

import {
  InboxNotification,
  InboxNotificationList,
} from "@repo/collaboration/client/inbox";
import { Button } from "@repo/design-system/components/ui/button";
import { CheckCheckIcon, InboxIcon } from "lucide-react";
import { useFeatureFlagGateOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import {
  type InboxNotificationSource,
  InboxTransportStatus,
} from "../lib/inbox-notification-source";
import { withoutRetiredInboxNotificationKinds } from "../lib/retired-inbox-notification-kinds";
import {
  INBOX_NOTIFICATION_KINDS,
  InboxActorRowsContext,
} from "./inbox-row-kinds";
import type { InboxSurfaceV2Props } from "./inbox-surface-v2-props";

/**
 * The Master Inbox, complete (ISS-9406, PRD-730 `wave-fs-2-web-to-desktop`).
 *
 * Owns the notification list, the mark-all-read control, the loading,
 * unavailable and empty renders, the row-kind registry and the actor treatment.
 * A host owns only the notification SOURCE: the records, the unread tally, the
 * read-state command, and the Liveblocks client context the rows resolve actor
 * names through. The rows are Liveblocks' own chrome, so a second host owes
 * records in that record shape — not merely bytes from somewhere.
 *
 * DESKTOP must not mount this until its adapter can produce the same
 * notification population and read-state commands. It cannot today:
 * `apps/desktop` declares neither `@repo/collaboration` nor `@liveblocks/*`, its
 * main process has OS toast delivery but no inbox record store, `apps/api`
 * exposes no notification read route, and `DESKTOP_SHELL_ROUTE_NAV_IDS` maps
 * Inbox to `null`. PRD-702 owns that transport;
 * `__tests__/inbox-both-host-contract.ts` is what will hold the two hosts to one
 * answer.
 *
 * Closed by default behind ONE PostHog key
 * (`INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY`), read once at the host's mount
 * site. This surface does not know that gate exists.
 */
export function InboxSurfaceV2({ source }: InboxSurfaceV2Props) {
  // Wait for the assignment: an unresolved flag reads as `false`, so deciding
  // early paints actor-less rows and rewrites every headline when it lands.
  const actorRows = useFeatureFlagGateOptional(
    INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY
  );
  const actorRowsEnabled = actorRows.enabled && actorRows.isReady;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6"
      data-testid={INBOX_SURFACE_V2_TEST_ID}
    >
      {inboxBody({ actorRowsEnabled, source })}
    </div>
  );
}

function inboxBody({
  actorRowsEnabled,
  source,
}: {
  actorRowsEnabled: boolean;
  source: InboxNotificationSource;
}) {
  if (source.status === InboxTransportStatus.Unavailable) {
    return (
      <InboxNotice
        description="Notifications are currently unavailable. Please try again later."
        testId={INBOX_SURFACE_V2_UNAVAILABLE_TEST_ID}
        title="Notifications unavailable"
      />
    );
  }
  if (source.status === InboxTransportStatus.Loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        data-testid={INBOX_SURFACE_V2_LOADING_TEST_ID}
      >
        <p className="text-muted-foreground">Loading notifications...</p>
      </div>
    );
  }
  const notifications = withoutRetiredInboxNotificationKinds(
    source.notifications
  );
  if (notifications.length === 0) {
    return (
      <InboxNotice
        description="You'll see notifications here when someone mentions you or comments on your work."
        testId={INBOX_SURFACE_V2_EMPTY_TEST_ID}
        title="No notifications yet"
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button
          disabled={source.unreadCount === 0}
          onClick={source.markAllAsRead}
          size="sm"
          variant="ghost"
        >
          <CheckCheckIcon className="h-4 w-4" />
          Mark all as read
        </Button>
      </div>
      <InboxActorRowsContext.Provider value={actorRowsEnabled}>
        <InboxNotificationList>
          {notifications.map((notification) => (
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

type InboxNoticeProps = {
  title: string;
  description: string;
  testId: string;
};

/**
 * The two states with nothing to list. They differ in COPY and in the locator
 * they emit, never in shape: a shared component that both call with the same
 * arguments is how "unavailable" came to be indistinguishable from "empty".
 */
function InboxNotice({ description, testId, title }: InboxNoticeProps) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 text-center"
      data-testid={testId}
    >
      <InboxIcon className="h-12 w-12 text-muted-foreground" />
      <p className="text-muted-foreground">{title}</p>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

/**
 * Marks the surface's root so a host's E2E can prove which branch of its gate
 * rendered — the OFF case asserts ABSENCE, and an absence written against copy
 * the two branches share would pass on either.
 */
export const INBOX_SURFACE_V2_TEST_ID = "inbox-surface-v2";

/**
 * One locator per state with nothing to list. "The empty copy is absent" is
 * satisfied by the loading render, by an error boundary and by a fixture that
 * returned nothing; these are emitted by exactly one branch each.
 */
export const INBOX_SURFACE_V2_UNAVAILABLE_TEST_ID =
  "inbox-surface-v2-unavailable";
export const INBOX_SURFACE_V2_EMPTY_TEST_ID = "inbox-surface-v2-empty";
export const INBOX_SURFACE_V2_LOADING_TEST_ID = "inbox-surface-v2-loading";
