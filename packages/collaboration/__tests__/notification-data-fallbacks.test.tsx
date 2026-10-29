// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared `@liveblocks/react-ui` stand-in; see the module for what it models.
vi.mock(
  "@liveblocks/react-ui",
  () => import("./support/liveblocks-react-ui-stub")
);

vi.mock("@liveblocks/react", () => ({
  useUser: () => ({ isLoading: false, user: undefined }),
}));

type Activity = { data?: object };

const ENTITY_URL = "https://app.example.com/closedloop-ai/documents/iss-1";

function makeNotification(kind: string, activities: Activity[]) {
  return {
    id: `in_${kind}`,
    kind,
    activities: activities.map((activity, index) => ({
      id: `ac_${index}`,
      ...activity,
    })),
  };
}

async function renderMention(activities: Activity[], showActor?: boolean) {
  const { MentionNotification } = await import(
    "../client/mention-notification"
  );
  type Props = Parameters<typeof MentionNotification>[0];
  const notification = makeNotification(
    "$mention",
    activities
  ) as unknown as Props["inboxNotification"];
  render(
    <MentionNotification
      inboxNotification={notification}
      showActor={showActor}
    />
  );
}

async function renderAssignment(activities: Activity[], showActor?: boolean) {
  const { AssignmentNotification } = await import(
    "../client/assignment-notification"
  );
  type Props = Parameters<typeof AssignmentNotification>[0];
  const notification = makeNotification(
    "$assignment",
    activities
  ) as unknown as Props["inboxNotification"];
  render(
    <AssignmentNotification
      inboxNotification={notification}
      showActor={showActor}
    />
  );
}

function strongText(): string | null {
  return (
    screen.getByTestId("title").querySelector("strong")?.textContent ?? null
  );
}

beforeEach(() => {
  vi.resetModules();
});

describe("MentionNotification data fallbacks", () => {
  it("renders the comment preview as the body when present", async () => {
    await renderMention([
      {
        data: {
          entityType: "issue",
          entityTitle: "Fix login",
          entityUrl: ENTITY_URL,
          commentPreview: "Can you take a look?",
        },
      },
    ]);
    expect(screen.getByTestId("body")).toHaveTextContent(
      "Can you take a look?"
    );
    expect(screen.getByTestId("title")).toHaveTextContent("issue");
    expect(strongText()).toBe("Fix login");
  });

  it("falls back to session / Untitled / empty href and renders no body when data is missing", async () => {
    await renderMention([{ data: {} }]);
    const title = screen.getByTestId("title");
    expect(title).toHaveTextContent("session");
    expect(strongText()).toBe("Untitled");
    expect(screen.getByTestId("notification")).toHaveAttribute("href", "");
    expect(screen.getByTestId("body")).toBeEmptyDOMElement();
  });

  it("uses the same fallbacks when the notification has no activities", async () => {
    await renderMention([]);
    expect(strongText()).toBe("Untitled");
    expect(screen.getByTestId("title")).toHaveTextContent("session");
    expect(screen.getByTestId("body")).toBeEmptyDOMElement();
  });

  it("uses the same fallbacks when the activity carries no data", async () => {
    await renderMention([{}]);
    expect(strongText()).toBe("Untitled");
    expect(screen.getByTestId("title")).toHaveTextContent("session");
    expect(screen.getByTestId("notification")).toHaveAttribute("href", "");
    expect(screen.getByTestId("body")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("aside")).toBeNull();
  });

  it.each([
    ["no activities", []],
    ["an activity with no data", [{}]],
  ] as [string, Activity[]][])(
    "holds an empty actor gutter for %s",
    async (_label, activities) => {
      await renderMention(activities, true);
      expect(strongText()).toBe("Untitled");
      expect(
        screen.getByTestId("aside").querySelector('[data-actor-gutter="empty"]')
      ).not.toBeNull();
    }
  );
});

describe("AssignmentNotification data fallbacks", () => {
  it("falls back to item / Untitled / empty href when data is missing", async () => {
    await renderAssignment([{ data: {} }]);
    const title = screen.getByTestId("title");
    expect(title).toHaveTextContent("item");
    expect(title).not.toHaveTextContent("session");
    expect(strongText()).toBe("Untitled");
    expect(screen.getByTestId("notification")).toHaveAttribute("href", "");
  });

  it("uses the same fallbacks when the notification has no activities", async () => {
    await renderAssignment([]);
    expect(strongText()).toBe("Untitled");
    expect(screen.getByTestId("title")).toHaveTextContent("item");
  });

  it("uses the same fallbacks when the activity carries no data", async () => {
    await renderAssignment([{}]);
    expect(strongText()).toBe("Untitled");
    expect(screen.getByTestId("title")).toHaveTextContent("item");
    expect(screen.getByTestId("notification")).toHaveAttribute("href", "");
    expect(screen.queryByTestId("aside")).toBeNull();
  });

  it.each([
    ["no activities", []],
    ["an activity with no data", [{}]],
  ] as [string, Activity[]][])(
    "holds an empty actor gutter for %s",
    async (_label, activities) => {
      await renderAssignment(activities, true);
      expect(strongText()).toBe("Untitled");
      expect(
        screen.getByTestId("aside").querySelector('[data-actor-gutter="empty"]')
      ).not.toBeNull();
    }
  );
});
