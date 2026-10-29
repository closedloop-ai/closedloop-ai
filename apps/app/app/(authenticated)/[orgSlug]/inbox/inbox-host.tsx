"use client";

import { ClientSideSuspense } from "@liveblocks/react/suspense";
import { InboxSurfaceV2 } from "@repo/app/inbox/components/inbox-surface-v2";
import {
  INBOX_SOURCE_LOADING,
  INBOX_SOURCE_UNAVAILABLE,
  InboxTransportStatus,
} from "@repo/app/inbox/lib/inbox-notification-source";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  useInboxNotifications,
  useMarkAllInboxNotificationsAsRead,
  useUnreadInboxNotificationsCount,
} from "@repo/collaboration/client/hooks";
import {
  LiveblocksErrorBoundary,
  useLiveblocksAvailability,
} from "@repo/collaboration/client/liveblocks-error-boundary";
import { InboxLegacyBody } from "./inbox-legacy-body";

/**
 * The WEB host of the Inbox route (ISS-9406, PRD-730).
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE: the transport, and only the transport —
 * where the records, the unread tally and the read-state command come from, and
 * whether this host can serve them at all. Every visible decision over those
 * values belongs to `InboxSurfaceV2`.
 *
 * ONE gate read, HERE, choosing between two whole bodies; neither branch knows
 * the gate exists. `isAvailable` is likewise derived once and handed to
 * whichever branch renders, so the two cannot classify one outage differently.
 *
 * The gate is READ THROUGH `useFeatureFlagGate` and the choice WAITS on
 * `isReady`. An unresolved assignment reads `false`, so deciding early mounts
 * the legacy body and its `ClientSideSuspense`, and then unmounts that whole
 * branch when PostHog answers — a user in the rollout pays "Loading
 * notifications..." twice, either side of a flash of the body they are not
 * getting. Both other reads in this feature already wait: the surface uses
 * `useFeatureFlagGateOptional` for the actor flag, and the legacy body gates on
 * `useFeatureFlagsLoaded`. `useFeatureFlagGate` carries its own deadline, so an
 * adapter that never resolves falls through rather than holding here forever.
 *
 * What renders while the gate is undecided belongs to NEITHER branch: it is the
 * legacy fallback's markup, which is also what the surface's own loading state
 * draws, so no gated locator or padding exists before the answer does. That is
 * the one visible thing this host owns, and it is about the gate rather than
 * about notifications.
 *
 * WHERE THE LIVEBLOCKS BOUNDARY SITS, and why it is not on the route (ISS-10202):
 * it wraps each transport BODY, below the gate read. A boundary spanning the
 * gate would catch a PostHog or feature-flag throw — which has no Liveblocks
 * attribution — and degrade the inbox for it, so `app/error.tsx` would never
 * render. Only the bodies below read `isAvailable` and have a Liveblocks-free
 * branch to fall back to, which is the one shape degrading describes.
 *
 * No desktop twin: PRD-702 owns desktop notification delivery, and until it
 * lands `apps/desktop` has no record store, no read-state command and no Inbox
 * nav id to mount against.
 */
export function InboxHost() {
  const { enabled: completeSurfaceEnabled, isReady } = useFeatureFlagGate(
    INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY
  );

  if (!isReady) {
    return <InboxGateUndecided />;
  }

  if (completeSurfaceEnabled) {
    return (
      <LiveblocksErrorBoundary>
        <InboxCompleteBody />
      </LiveblocksErrorBoundary>
    );
  }

  return (
    <LiveblocksErrorBoundary>
      <InboxLegacyHost />
    </LiveblocksErrorBoundary>
  );
}

/**
 * Each branch mounts its own boundary rather than one above a body chosen by a
 * prop: the gate is read once and picks between two whole shapes, and neither
 * body is handed the boolean.
 */
function InboxCompleteBody() {
  const { isAvailable } = useLiveblocksAvailability();

  if (!isAvailable) {
    return <InboxSurfaceV2 source={INBOX_SOURCE_UNAVAILABLE} />;
  }

  return (
    <ClientSideSuspense
      fallback={<InboxSurfaceV2 source={INBOX_SOURCE_LOADING} />}
    >
      <InboxSurfaceV2WithNotifications />
    </ClientSideSuspense>
  );
}

function InboxLegacyHost() {
  const { isAvailable } = useLiveblocksAvailability();

  return <InboxLegacyBody isAvailable={isAvailable} />;
}

/** Separate because the Liveblocks read suspends into the fallback above. */
function InboxSurfaceV2WithNotifications() {
  const { inboxNotifications } = useInboxNotifications();
  const markAllAsRead = useMarkAllInboxNotificationsAsRead();
  const { count: unreadCount } = useUnreadInboxNotificationsCount();

  return (
    <InboxSurfaceV2
      source={{
        markAllAsRead,
        notifications: inboxNotifications,
        status: InboxTransportStatus.Ready,
        unreadCount,
      }}
    />
  );
}

/**
 * The render that commits to neither body. Deliberately the legacy fallback's
 * markup rather than `InboxSurfaceV2 source={INBOX_SOURCE_LOADING}`: the surface
 * would stamp `data-testid="inbox-surface-v2"` and its own padding onto a page
 * whose gate has not answered, which is both a gated locator appearing before
 * the gate and a false negative waiting to happen for the OFF-branch E2E, which
 * asserts that locator is ABSENT.
 */
function InboxGateUndecided() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-muted-foreground">Loading notifications...</p>
    </div>
  );
}
