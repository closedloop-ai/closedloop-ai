// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The page is the production wiring under test: it decides, from the PostHog
// flag, WHICH component the Liveblocks `kinds` map hands each notification. The
// stubs below replace only the Liveblocks plumbing; the real
// `AssignmentNotification` is rendered so the assertion is on what a row
// actually says, not on which symbol was referenced.

type NotificationStub = {
  id: string;
  kind: string;
  activities: { id: string; data: Record<string, unknown> }[];
};

type KindComponents = Record<
  string,
  ComponentType<{ inboxNotification: NotificationStub }>
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

const MARK_ALL_AS_READ_LABEL = /mark all as read/i;

let flagEnabled = false;
let flagsLoaded = true;
// Mutable so a test can put a $mention row through the page's own kinds map;
// the hook mock below reads this on every render.
let notifications: NotificationStub[] = [];

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) =>
    flag === "inbox-notification-actor"
      ? { enabled: flagEnabled }
      : { enabled: false },
  useFeatureFlagsLoaded: () => flagsLoaded,
}));

vi.mock("@liveblocks/react/suspense", () => ({
  ClientSideSuspense: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
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

// Dispatch through the page's own `kinds` map, exactly as Liveblocks does, so
// deleting the flag branch in the page would fail this test.
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
    const Kind = kinds[inboxNotification.kind];
    return (
      <li>
        <Kind inboxNotification={inboxNotification} />
      </li>
    );
  },
}));

vi.mock("@repo/collaboration/client/hooks", () => ({
  useInboxNotifications: () => ({ inboxNotifications: notifications }),
  useMarkAllInboxNotificationsAsRead: () => vi.fn(),
  useUnreadInboxNotificationsCount: () => ({ count: 1 }),
}));

vi.mock("@repo/collaboration/client/liveblocks-error-boundary", () => ({
  useLiveblocksAvailability: () => ({ isAvailable: true }),
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <header />,
}));

async function renderInbox() {
  const { default: InboxPage } = await import("../page");
  render(<InboxPage />);
}

beforeEach(() => {
  vi.resetModules();
  flagEnabled = false;
  flagsLoaded = true;
  notifications = [ASSIGNMENT];
});

describe("InboxPage assignment rows", () => {
  it("keeps the passive, actor-less headline while the flag is off", async () => {
    await renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("renders the assigning actor once the flag is on", async () => {
    flagEnabled = true;
    await renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen assigned you artifact Fix session transcripts"
    );
    expect(screen.getByTestId("actor-avatar")).toHaveAttribute(
      "data-user-id",
      "user_emma"
    );
  });

  it("keeps the actor-less rows until PostHog has actually answered", async () => {
    // An unresolved flag reads as `false`. Deciding before flags load would
    // paint the actor-less rows and then remount every one of them.
    flagEnabled = true;
    flagsLoaded = false;
    await renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("still offers Mark all as read in both flag states", async () => {
    await renderInbox();
    expect(
      screen.getByRole("button", { name: MARK_ALL_AS_READ_LABEL })
    ).toBeEnabled();
  });
});

describe("InboxPage mention rows", () => {
  it("routes $mention through the same flag as $assignment", async () => {
    notifications = [MENTION];
    flagEnabled = true;
    await renderInbox();

    // The $mention entry in the page's kinds map is production wiring of its
    // own: the package-level mention tests render the component directly and
    // never touch this map.
    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen mentioned you in session Nightly review"
    );
    expect(screen.getByTestId("actor-avatar")).toHaveAttribute(
      "data-user-id",
      "user_emma"
    );
  });

  it("keeps the passive mention headline while the flag is off", async () => {
    notifications = [MENTION];
    await renderInbox();

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were mentioned in a comment on session Nightly review"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
    expect(screen.queryByTestId("aside")).toBeNull();
  });
});

describe("InboxPage flag transitions", () => {
  it("re-renders the rows in place when PostHog answers, instead of remounting them", async () => {
    flagEnabled = true;
    flagsLoaded = false;
    const { default: InboxPage } = await import("../page");
    const { rerender } = render(<InboxPage />);

    const before = screen.getByTestId("notification");
    expect(before).toHaveTextContent("You were assigned to artifact");

    flagsLoaded = true;
    rerender(<InboxPage />);

    const after = screen.getByTestId("notification");
    expect(after).toHaveTextContent("Emma Chen assigned you artifact");
    // Same DOM node. Choosing a different component type out of the kinds map
    // once the flag resolves would unmount every affected row and build a new
    // node here, which is the transition this wiring exists to avoid.
    expect(after).toBe(before);
  });
});
