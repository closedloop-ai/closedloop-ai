// @vitest-environment jsdom
import { LiveblocksProvider } from "@liveblocks/react";
import {
  INBOX_BOTH_HOST_CONTRACT,
  type InboxBothHostFixture,
} from "@repo/app/inbox/__tests__/inbox-both-host-contract";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  runBothHostContract,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { InboxHost } from "../inbox-host";

/**
 * ISS-9406 — the WEB half of the Inbox both-host contract, run against this
 * shell's real mount: the host adapter, its gate read, the surface it selects
 * and Liveblocks' real notification chrome.
 *
 * Nothing about the RENDER is stubbed, which is what makes AC1's facts checkable
 * at all: `data-unread` and `<time datetime>` come from the shipped chrome, not
 * from a mock written to satisfy this file. Only the transport is replaced.
 *
 * `apps/desktop` supplies no twin because it mounts nothing to supply one from:
 * no `@repo/collaboration`, no `@liveblocks/*`, no record store, no Inbox nav
 * id. PRD-702 owns that transport.
 */

type NotificationRecord = InboxBothHostFixture["notifications"][number];

let notifications: readonly NotificationRecord[] = [];

vi.mock("@liveblocks/react/suspense", () => ({
  ClientSideSuspense: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@repo/collaboration/client/hooks", () => ({
  useInboxNotifications: () => ({ inboxNotifications: notifications }),
  useMarkAllInboxNotificationsAsRead: () => () => undefined,
  useUnreadInboxNotificationsCount: () => ({ count: notifications.length }),
}));

vi.mock("@repo/collaboration/client/liveblocks-error-boundary", () => ({
  // Pass-through: ISS-10202 moved the mount into `InboxHost`, so this suite
  // renders through it. Its catch/degrade semantics are pinned in
  // `packages/collaboration/__tests__/liveblocks-error-boundary.test.tsx` and
  // its HEIGHT in the sibling `boundary-mount.test.tsx`.
  LiveblocksErrorBoundary: ({ children }: { children: ReactNode }) => children,
  useLiveblocksAvailability: () => ({ isAvailable: true }),
}));

/** The org roster Liveblocks resolves actor ids against, as web supplies one. */
function resolveUsers({ userIds }: { userIds: readonly string[] }) {
  return userIds.map((userId) =>
    userId === "user_emma" ? { color: "#8b5cf6", name: "Emma Chen" } : undefined
  );
}

runBothHostContract<InboxBothHostFixture>({
  contract: INBOX_BOTH_HOST_CONTRACT,
  host: WEB_HOST,
  mount: (fixture) => {
    cleanup();
    notifications = fixture.notifications;
    render(
      <LiveblocksProvider
        // Never resolves, and never needs to: the inbox rows read the client's
        // user resolver, and only entering a ROOM would authenticate.
        authEndpoint={() => new Promise(() => undefined)}
        resolveUsers={resolveUsers}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: fixture.actorRowsEnabled
              ? ["inbox-complete-surface", "inbox-notification-actor"]
              : ["inbox-complete-surface"],
          })}
        >
          <InboxHost />
        </FeatureFlagAdapterProvider>
      </LiveblocksProvider>
    );
  },
});
