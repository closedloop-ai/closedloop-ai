// @vitest-environment jsdom
import { RetiredInboxNotificationKind } from "@repo/api/src/types/retired-inbox-notification-kinds";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enabledThroughWebAdapter } from "@/__tests__/helpers/web-feature-flag-provider";
import InboxPage from "../page";

// The route is the production wiring under test: it reads ONE gate and picks
// between two whole bodies, and it derives the transport those bodies render
// from. Only the Liveblocks plumbing is stubbed; the real row components and the
// real `InboxSurfaceV2` render, so an assertion is on what the page says.

type NotificationStub = {
  id: string;
  kind: string;
  activities: { id: string; data: Record<string, unknown> }[];
};

type KindComponents = Record<
  string,
  ComponentType<{ inboxNotification: NotificationStub }> | undefined
>;

const ASSIGNMENT: NotificationStub = {
  id: "in_1",
  kind: "$assignment",
  activities: [
    {
      id: "ac_1",
      data: {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: "/closedloop-ai/documents/iss-1",
        actorId: "user_emma",
      },
    },
  ],
};

const MENTION: NotificationStub = {
  id: "in_2",
  kind: "$mention",
  activities: [
    {
      id: "ac_2",
      data: {
        entityType: "session",
        entityTitle: "Nightly review",
        entityUrl: "/closedloop-ai/sessions/ses-1",
        actorId: "user_emma",
        commentPreview: "can you take a look?",
      },
    },
  ],
};

/** A stored notification whose producer PRD-795 removed. */
const RETIRED_KIND: NotificationStub = {
  id: "in_3",
  kind: RetiredInboxNotificationKind.LoopCompleted,
  activities: [{ id: "ac_3", data: { loopTitle: "Weekly digest" } }],
};

/** Indexed through a variable: a literal `.__proto__` access is itself barred. */
const INHERITED_KEYS = ["__proto__", "constructor", "toString"] as const;

const MARK_ALL_AS_READ_LABEL = /mark all as read/i;
const V2_SURFACE_TEST_ID = "inbox-surface-v2";
const V2_UNAVAILABLE_TEST_ID = "inbox-surface-v2-unavailable";
const V2_EMPTY_TEST_ID = "inbox-surface-v2-empty";
const V2_LOADING_TEST_ID = "inbox-surface-v2-loading";

/** Every `kinds` table a branch actually handed the dispatcher. */
const kindTables: KindComponents[] = [];

let analyticsFlagEnabled = false;
let analyticsFlagsLoaded = true;
let notifications: NotificationStub[] = [];
let isAvailable = true;
const markAllAsRead = vi.fn();

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) =>
    flag === "inbox-notification-actor"
      ? { enabled: analyticsFlagEnabled }
      : { enabled: false },
  useFeatureFlagsLoaded: () => analyticsFlagsLoaded,
}));

// Switchable: the loading state is the host's Suspense FALLBACK, and a
// pass-through mock leaves which arm of the union it is built from unasserted.
let readSuspends = false;

vi.mock("@liveblocks/react/suspense", () => ({
  ClientSideSuspense: ({
    children,
    fallback,
  }: {
    children: ReactNode;
    fallback: ReactNode;
  }) => <>{readSuspends ? fallback : children}</>,
}));

vi.mock("@liveblocks/react", () => ({
  useUser: (userId: string) =>
    userId === "user_emma"
      ? { isLoading: false, user: { name: "Emma Chen" } }
      : { isLoading: false, user: undefined },
}));

vi.mock("@liveblocks/react-ui", () => ({
  InboxNotification: {
    Custom: ({
      title,
      aside,
      href,
    }: {
      title: ReactNode;
      aside?: ReactNode;
      href: string;
    }) => (
      <a data-testid="notification" href={href}>
        {/* Liveblocks renders the aside column only when `aside` is truthy. */}
        {aside ? <span data-testid="aside">{aside}</span> : null}
        <span data-testid="title">{title}</span>
      </a>
    ),
    Avatar: ({ userId }: { userId: string }) => (
      <span data-testid="actor-avatar" data-user-id={userId} />
    ),
  },
}));

// Dispatch through whichever kinds map the rendering branch supplies, exactly as
// Liveblocks does, so deleting a kind from either one would fail here.
vi.mock("@repo/collaboration/client/inbox", () => ({
  InboxNotificationList: ({ children }: { children: ReactNode }) => (
    <ol>{children}</ol>
  ),
  InboxNotification: ({
    inboxNotification,
    kinds,
  }: {
    inboxNotification: NotificationStub;
    kinds: KindComponents;
  }) => {
    kindTables.push(kinds);
    const Kind = kinds[inboxNotification.kind];
    return (
      <li>{Kind ? <Kind inboxNotification={inboxNotification} /> : null}</li>
    );
  },
}));

vi.mock("@repo/collaboration/client/hooks", () => ({
  useInboxNotifications: () => ({ inboxNotifications: notifications }),
  useMarkAllInboxNotificationsAsRead: () => markAllAsRead,
  useUnreadInboxNotificationsCount: () => ({ count: 1 }),
}));

vi.mock("@repo/collaboration/client/liveblocks-error-boundary", () => ({
  // Pass-through: this suite drives availability directly through the hook
  // above, and the boundary's own catch/escalate behavior is pinned by
  // `packages/collaboration/__tests__/liveblocks-error-boundary.test.tsx`.
  LiveblocksErrorBoundary: ({ children }: { children: ReactNode }) => children,
  useLiveblocksAvailability: () => ({ isAvailable }),
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <header />,
}));

function renderInbox({ completeSurface = false, gateResolved = true } = {}) {
  const pinned = createStaticFeatureFlagAdapter({
    enabledFlags: completeSurface ? ["inbox-complete-surface"] : [],
  });
  // The actor key is driven through the `@repo/analytics/client` fixture
  // above; the inbox reads it through the port, so it resolves through the
  // real web adapter while the static adapter pins the rest.
  const base = {
    ...pinned,
    useFeatureFlagEnabled: enabledThroughWebAdapter(
      ["inbox-notification-actor"],
      pinned.useFeatureFlagEnabled
    ),
  };
  // `createStaticFeatureFlagAdapter` implements no `useFeatureFlagResolved`, so
  // it reads as ALWAYS resolved and cannot reach the undecided branch on its
  // own. Adding the hook is what makes that branch reachable at all.
  const adapter = gateResolved
    ? base
    : { ...base, useFeatureFlagResolved: () => false };

  render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <InboxPage />
    </FeatureFlagAdapterProvider>
  );
}

beforeEach(() => {
  markAllAsRead.mockClear();
  analyticsFlagEnabled = false;
  analyticsFlagsLoaded = true;
  isAvailable = true;
  readSuspends = false;
  kindTables.length = 0;
  notifications = [ASSIGNMENT];
});

describe("the Inbox route's gate", () => {
  it("keeps the pre-existing composition while the gate is closed", () => {
    renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    // The gate's whole point. Asserted on a locator only the complete surface
    // emits, because both branches render the same copy — an absence written
    // against the headline above would pass on either.
    expect(screen.queryByTestId(V2_SURFACE_TEST_ID)).toBeNull();
  });

  it("mounts the complete surface once the gate is open", () => {
    renderInbox({ completeSurface: true });

    expect(screen.getByTestId(V2_SURFACE_TEST_ID)).toBeVisible();
    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
  });

  it("commits to neither body until the gate has answered", () => {
    // An unresolved assignment reads `false`, so choosing early mounts the
    // legacy body and its suspense and then unmounts the whole branch when
    // PostHog answers — two loading states either side of a body the user in
    // the rollout is not getting. Enabled AND unresolved is the case that
    // catches it: a `false` reading here is indistinguishable from the closed
    // gate below unless the flag would otherwise be ON.
    renderInbox({ completeSurface: true, gateResolved: false });

    expect(screen.queryByTestId(V2_SURFACE_TEST_ID)).toBeNull();
    expect(screen.queryByTestId("title")).toBeNull();
    expect(screen.getByText("Loading notifications...")).toBeVisible();
  });

  it("still commits to neither body when the gate is closed and unresolved", () => {
    renderInbox({ gateResolved: false });

    expect(screen.queryByTestId(V2_SURFACE_TEST_ID)).toBeNull();
    expect(screen.queryByTestId("title")).toBeNull();
  });
});

/**
 * `kind` is an untrusted wire string, so the table it indexes must answer
 * nothing for a key nobody registered. BOTH branches: a hazard closed on one
 * side of a gate is still open for every reader on the other.
 */
describe.each([
  ["the closed branch", false],
  ["the complete surface", true],
])("%s row-kind table", (_name, completeSurface) => {
  it("answers nothing for a kind nobody registered", () => {
    renderInbox({ completeSurface });
    const kinds = kindTables[0] as unknown as Record<string, unknown>;

    expect(kinds.$assignment).toBeDefined();
    for (const key of INHERITED_KEYS) {
      expect(kinds[key], `kinds.${key}`).toBeUndefined();
    }
  });
});

/**
 * PRD-795: stored notifications of a retired kind never reach the dispatcher,
 * on either branch, and a list holding only them reads as empty.
 */
describe.each([
  ["the closed branch", false],
  ["the complete surface", true],
])("%s retired kinds", (_name, completeSurface) => {
  it("lists no row for a retired kind", () => {
    notifications = [ASSIGNMENT, RETIRED_KIND];
    renderInbox({ completeSurface });

    // One list item per record handed to the dispatcher: an unregistered kind
    // would still get its own (empty) item.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows the empty state when only retired kinds are stored", () => {
    notifications = [RETIRED_KIND];
    renderInbox({ completeSurface });

    expect(screen.getByText("No notifications yet")).toBeVisible();
    expect(screen.queryByTestId("notification")).toBeNull();
  });
});

describe("the Inbox route's transport", () => {
  it("tells the surface the transport is unavailable rather than empty", () => {
    isAvailable = false;
    renderInbox({ completeSurface: true });

    expect(screen.getByTestId(V2_UNAVAILABLE_TEST_ID)).toBeVisible();
    expect(screen.queryByTestId(V2_EMPTY_TEST_ID)).toBeNull();
  });

  it("reports an empty inbox rather than an unavailable one on a successful read of nothing", () => {
    notifications = [];
    renderInbox({ completeSurface: true });

    expect(screen.getByTestId(V2_EMPTY_TEST_ID)).toBeVisible();
    expect(screen.queryByTestId(V2_UNAVAILABLE_TEST_ID)).toBeNull();
  });

  it("routes the surface's mark-all-read to this host's Liveblocks command", async () => {
    renderInbox({ completeSurface: true });

    await userEvent.click(
      screen.getByRole("button", { name: MARK_ALL_AS_READ_LABEL })
    );

    // The route's share of AC3 is the WIRING. The control going inert on the
    // reconciled tally is asserted where a reconciling host exists —
    // `inbox-surface-v2.test.tsx`, and the e2e against real Liveblocks.
    expect(markAllAsRead).toHaveBeenCalledTimes(1);
  });

  it("shows the surface's loading state, not its unavailable one, while the read is in flight", () => {
    readSuspends = true;
    renderInbox({ completeSurface: true });

    expect(screen.getByTestId(V2_LOADING_TEST_ID)).toBeVisible();
    expect(screen.queryByTestId(V2_UNAVAILABLE_TEST_ID)).toBeNull();
    expect(screen.queryByTestId(V2_EMPTY_TEST_ID)).toBeNull();
  });

  it("classifies an unavailable transport the same way on the closed branch", () => {
    isAvailable = false;
    renderInbox();

    expect(screen.getByText("Notifications unavailable")).toBeVisible();
    expect(screen.queryByText("No notifications yet")).toBeNull();
  });
});

describe("the closed branch's actor rows", () => {
  it("keeps the passive headline while the actor flag is off", () => {
    renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("renders the assigning actor once the actor flag is on", () => {
    analyticsFlagEnabled = true;
    renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen assigned you artifact Fix session transcripts"
    );
    expect(screen.getByTestId("actor-avatar")).toHaveAttribute(
      "data-user-id",
      "user_emma"
    );
  });

  it("routes $mention through the same actor gate as $assignment", () => {
    // The closed branch keeps its own kinds map, and the package-level mention
    // tests render the component directly — the only cover on this wiring.
    notifications = [MENTION];
    analyticsFlagEnabled = true;
    renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen mentioned you in session Nightly review"
    );
  });

  it("keeps the actor-less rows until PostHog has actually answered", () => {
    // An unresolved flag reads as `false`. Deciding before flags load would
    // paint the actor-less rows and then remount every one of them.
    analyticsFlagEnabled = true;
    analyticsFlagsLoaded = false;
    renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });
});
