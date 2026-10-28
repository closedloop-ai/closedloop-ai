import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InboxNotificationSource,
  InboxSurfaceNotification,
} from "../../lib/inbox-notification-source";
import {
  INBOX_SOURCE_LOADING,
  INBOX_SOURCE_UNAVAILABLE,
  InboxTransportStatus,
} from "../../lib/inbox-notification-source";
import {
  INBOX_SURFACE_V2_EMPTY_TEST_ID,
  INBOX_SURFACE_V2_LOADING_TEST_ID,
  INBOX_SURFACE_V2_UNAVAILABLE_TEST_ID,
  InboxSurfaceV2,
} from "../inbox-surface-v2";

/**
 * ISS-9406 — what the surface decides, with no host in the way.
 *
 * The Liveblocks chrome is stubbed as
 * `packages/collaboration/__tests__/notification-actor-rows.test.tsx` stubs it;
 * the ROW components are the real ones. `InboxNotification` here re-implements
 * the one thing Liveblocks does with `kinds` — index it by the record's own
 * `kind` — and captures the table for direct inspection.
 */

type CapturedRow = {
  record: InboxSurfaceNotification;
  kinds: Record<string, unknown>;
};

const captured: CapturedRow[] = [];

vi.mock("@repo/collaboration/client/inbox", () => ({
  InboxNotificationList: ({ children }: { children: ReactNode }) => (
    <ol>{children}</ol>
  ),
  InboxNotification: ({
    inboxNotification,
    kinds,
  }: {
    inboxNotification: InboxSurfaceNotification;
    kinds: Record<string, unknown>;
  }) => {
    captured.push({ kinds, record: inboxNotification });
    const Kind = kinds[inboxNotification.kind] as
      | ((props: { inboxNotification: InboxSurfaceNotification }) => ReactNode)
      | undefined;
    return (
      <li>{Kind ? <Kind inboxNotification={inboxNotification} /> : null}</li>
    );
  },
}));

vi.mock("@liveblocks/react-ui", () => ({
  InboxNotification: {
    Custom: ({
      aside,
      href,
      title,
    }: {
      aside?: ReactNode;
      href: string;
      title: ReactNode;
    }) => (
      <a data-testid="notification" href={href}>
        {/* Liveblocks renders the aside column only when `aside` is truthy, so
            the stub must too — the actor avatar lives in it. */}
        {aside ? <span data-testid="aside">{aside}</span> : null}
        <span data-testid="title">{title}</span>
      </a>
    ),
    Avatar: ({ userId }: { userId: string }) => (
      <span data-testid="actor-avatar" data-user-id={userId} />
    ),
  },
}));

vi.mock("@liveblocks/react", () => ({
  useUser: (userId: string) =>
    userId === "user_emma"
      ? { isLoading: false, user: { name: "Emma Chen" } }
      : { isLoading: false, user: undefined },
}));

const NOTIFIED_AT = new Date("2026-09-01T10:00:00.000Z");
const READ_AT = new Date("2026-09-01T11:00:00.000Z");

const ASSIGNMENT = {
  activities: [
    {
      createdAt: NOTIFIED_AT,
      data: {
        actorId: "user_emma",
        entityTitle: "Fix session transcripts",
        entityType: "artifact",
        entityUrl: "/closedloop-ai/documents/iss-1",
      },
      id: "ac_1",
    },
  ],
  id: "in_1",
  kind: "$assignment",
  notifiedAt: NOTIFIED_AT,
  readAt: null,
  subjectId: "sub_1",
} as unknown as InboxSurfaceNotification;

const MENTION = {
  activities: [
    {
      createdAt: READ_AT,
      data: {
        actorId: "user_emma",
        commentPreview: "can you take a look?",
        entityTitle: "Nightly review",
        entityType: "session",
        entityUrl: "/closedloop-ai/sessions/ses-1",
      },
      id: "ac_2",
    },
  ],
  id: "in_2",
  kind: "$mention",
  notifiedAt: READ_AT,
  readAt: READ_AT,
  subjectId: "sub_2",
} as unknown as InboxSurfaceNotification;

function readySource(
  notifications: readonly InboxSurfaceNotification[],
  unreadCount: number,
  markAllAsRead: () => void = () => undefined
): InboxNotificationSource {
  return {
    markAllAsRead,
    notifications,
    status: InboxTransportStatus.Ready,
    unreadCount,
  };
}

function WithFlagAdapter({
  adapter,
  children,
}: {
  adapter: FeatureFlagAdapter;
  children: ReactNode;
}) {
  return (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

const ACTOR_GATE_OPEN = createStaticFeatureFlagAdapter({
  enabledFlags: [INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY],
});
const ACTOR_GATE_CLOSED = createStaticFeatureFlagAdapter();
/**
 * Enabled but NOT YET RESOLVED — PostHog's state on first paint, and the only
 * one that tells `enabled` apart from `enabled && isReady`. The static adapter
 * implements no `useFeatureFlagResolved`, so it cannot reach this.
 */
const ACTOR_GATE_UNRESOLVED: FeatureFlagAdapter = {
  useFeatureFlagEnabled: () => true,
  useFeatureFlagResolved: () => false,
};

/** Indexed through a variable: a literal `.__proto__` access is itself barred. */
const INHERITED_KEYS = ["__proto__", "constructor", "toString"] as const;

const MARK_ALL_AS_READ = /mark all as read/i;

beforeEach(() => {
  captured.length = 0;
});

/**
 * Each case asserts a locator only ONE branch emits and names the other two
 * absent: "the empty copy is not there" is satisfied by the loading render, by
 * an error boundary and by a fixture that returned nothing.
 */
describe("InboxSurfaceV2 transport states", () => {
  it("renders the unavailable notice, and never the empty one, when the transport cannot answer", () => {
    render(<InboxSurfaceV2 source={INBOX_SOURCE_UNAVAILABLE} />);

    expect(
      screen.getByTestId(INBOX_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).toHaveTextContent("Notifications unavailable");
    expect(screen.queryByTestId(INBOX_SURFACE_V2_EMPTY_TEST_ID)).toBeNull();
    expect(screen.queryByTestId(INBOX_SURFACE_V2_LOADING_TEST_ID)).toBeNull();
  });

  it("renders the empty notice, and never the unavailable one, on a successful read of nothing", () => {
    render(<InboxSurfaceV2 source={readySource([], 0)} />);

    expect(
      screen.getByTestId(INBOX_SURFACE_V2_EMPTY_TEST_ID)
    ).toHaveTextContent("No notifications yet");
    expect(
      screen.queryByTestId(INBOX_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).toBeNull();
    expect(screen.queryByTestId(INBOX_SURFACE_V2_LOADING_TEST_ID)).toBeNull();
  });

  it("renders the loading state as neither of them while a read is in flight", () => {
    render(<InboxSurfaceV2 source={INBOX_SOURCE_LOADING} />);

    expect(screen.getByTestId(INBOX_SURFACE_V2_LOADING_TEST_ID)).toBeVisible();
    expect(screen.queryByTestId(INBOX_SURFACE_V2_EMPTY_TEST_ID)).toBeNull();
    expect(
      screen.queryByTestId(INBOX_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).toBeNull();
  });
});

describe("InboxSurfaceV2 notification records", () => {
  it("hands each row its own record unmodified, in the order the host gave them", () => {
    render(<InboxSurfaceV2 source={readySource([ASSIGNMENT, MENTION], 1)} />);

    // Whole records, in order: every field a host could reproject on the way
    // through is inside this comparison, which is what AC1 rests on.
    expect(captured.map((row) => row.record)).toEqual([ASSIGNMENT, MENTION]);
  });

  it("gives the row table no answer for a kind nobody registered", () => {
    render(<InboxSurfaceV2 source={readySource([ASSIGNMENT], 1)} />);
    const kinds = captured[0]?.kinds as Record<string, unknown>;

    expect(kinds.$assignment).toBeDefined();
    for (const key of INHERITED_KEYS) {
      expect(kinds[key], `kinds.${key}`).toBeUndefined();
    }
  });
});

describe("InboxSurfaceV2 actor treatment", () => {
  it("keeps the passive headline while the gate is closed", () => {
    render(
      <WithFlagAdapter adapter={ACTOR_GATE_CLOSED}>
        <InboxSurfaceV2 source={readySource([ASSIGNMENT], 1)} />
      </WithFlagAdapter>
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("names the actor once the gate the surface itself reads is open", () => {
    render(
      <WithFlagAdapter adapter={ACTOR_GATE_OPEN}>
        <InboxSurfaceV2 source={readySource([ASSIGNMENT], 1)} />
      </WithFlagAdapter>
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen assigned you artifact Fix session transcripts"
    );
    expect(screen.getByTestId("actor-avatar")).toHaveAttribute(
      "data-user-id",
      "user_emma"
    );
  });

  it("keeps the actor-less rows until the assignment has actually resolved", () => {
    render(
      <WithFlagAdapter adapter={ACTOR_GATE_UNRESOLVED}>
        <InboxSurfaceV2 source={readySource([ASSIGNMENT], 1)} />
      </WithFlagAdapter>
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("re-renders the row in place when the assignment lands, not remounting it", () => {
    let resolved = false;
    // ONE adapter object across both renders: the gate hook selects its
    // resolver off the adapter identity, so a fresh object between renders
    // would change hook order instead of answering what this asks.
    const gate: FeatureFlagAdapter = {
      useFeatureFlagEnabled: () => true,
      useFeatureFlagResolved: () => resolved,
    };
    const source = readySource([ASSIGNMENT], 1);
    // A FRESH element each time, with the adapter and source objects held
    // stable: re-rendering the identical element is a reference-equality bailout
    // React skips, which would leave the row untouched for the wrong reason.
    const tree = () => (
      <WithFlagAdapter adapter={gate}>
        <InboxSurfaceV2 source={source} />
      </WithFlagAdapter>
    );

    const { rerender } = render(tree());
    const before = screen.getByTestId("notification");
    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );

    resolved = true;
    rerender(tree());

    // The headline MUST move, or the identity assertion below is satisfied by a
    // gate that never opened at all.
    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen assigned you artifact Fix session transcripts"
    );
    // Same DOM node. Picking a different component type out of the registry
    // once the assignment lands would unmount every affected row and build a
    // new one here — the transition carrying the gate as context avoids.
    expect(screen.getByTestId("notification")).toBe(before);
  });
});

/**
 * A host whose command actually reconciles, so the assertion is on the state the
 * reader is left in. A spy would go green against a surface that issued the
 * command and went on claiming there was something left to read.
 */
function ReconcilingInbox() {
  const [unreadCount, setUnreadCount] = useState(2);
  return (
    <InboxSurfaceV2
      source={readySource([ASSIGNMENT, MENTION], unreadCount, () =>
        setUnreadCount(0)
      )}
    />
  );
}

describe("InboxSurfaceV2 mark-all-read", () => {
  it("reaches the reader and reconciles through the host's command", async () => {
    render(<ReconcilingInbox />);
    const control = screen.getByRole("button", { name: MARK_ALL_AS_READ });
    expect(control).toBeEnabled();

    await userEvent.click(control);

    expect(
      screen.getByRole("button", { name: MARK_ALL_AS_READ })
    ).toBeDisabled();
  });

  it("offers nothing to do when the host reports no unread records", () => {
    render(<InboxSurfaceV2 source={readySource([ASSIGNMENT, MENTION], 0)} />);

    expect(
      screen.getByRole("button", { name: MARK_ALL_AS_READ })
    ).toBeDisabled();
  });
});
