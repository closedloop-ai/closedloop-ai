/**
 * Branch tests for story scaffolding the story sweep only drives down its
 * happy path: the Inbox's Liveblocks fetch polyfill (`inbox-fixtures.tsx`),
 * the Clerk and timer decorators of the auth screens (`auth-page.tsx`), the
 * Branches cell examples' column lookup, and the sort-order builder's handling
 * of a level that lists no groups.
 */
import { useClerk, useSignIn } from "@repo/auth/client";
import { composeStory } from "@storybook/react";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchCellExamples } from "../stories/composites-v2/v2-branches-list-cells";
import {
  withClerkState,
  withFastForward,
} from "../stories/surfaces-v2/auth-page";
import {
  inboxNotificationsFixture,
  LiveblocksInbox,
} from "../stories/surfaces-v2/fixtures/inbox-fixtures";
import {
  buildStorySortOrder,
  storybookBaselineRoot,
  storybookLevelGroupOrder,
} from "../story-group-order";

const captured = vi.hoisted(() => ({
  fetch: null as typeof fetch | null,
}));

vi.mock("@repo/collaboration/client/hooks", () => ({
  LiveblocksProvider: ({
    children,
    polyfills,
  }: {
    children: ReactNode;
    polyfills: { fetch: typeof fetch };
  }) => {
    captured.fetch = polyfills.fetch;
    return <div>{children}</div>;
  },
}));

const ORIGIN = "http://localhost";
const LIST_PATH = "/v2/c/inbox-notifications";
const EMPTY_LEVEL = "Tail Branch Empty Level";
const STILL_PENDING = "still pending";
const NO_SUCH_COLUMN = /the Branches list has no "no-such-column" column/;

const originalSetTimeout = Object.getOwnPropertyDescriptor(
  globalThis,
  "setTimeout"
);

afterEach(() => {
  vi.restoreAllMocks();
  captured.fetch = null;
  Reflect.deleteProperty(storybookLevelGroupOrder, EMPTY_LEVEL);
  if (originalSetTimeout) {
    Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
  }
});

function inboxFetch(
  state: Parameters<typeof LiveblocksInbox>[0]["state"]
): typeof fetch {
  render(<LiveblocksInbox state={state}>{null}</LiveblocksInbox>);
  if (!captured.fetch) {
    throw new Error("LiveblocksInbox did not hand its provider a fetch");
  }
  return captured.fetch;
}

describe("LiveblocksInbox fetch polyfill", () => {
  it("lists the notifications for a URL input and counts only the unread ones for a Request", async () => {
    const notifications = inboxNotificationsFixture();
    const answer = inboxFetch({ kind: "ready", notifications });

    const list = await answer(new URL(LIST_PATH, ORIGIN));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { inboxNotifications: unknown[] };
    expect(listed.inboxNotifications).toEqual(notifications);

    const count = await answer(
      new Request(new URL(`${LIST_PATH}/count`, ORIGIN))
    );
    const unread = notifications.filter((item) => item.readAt === null);
    expect(unread.length).toBeLessThan(notifications.length);
    expect(await count.json()).toEqual({ count: unread.length });
  });

  it("answers the delta read with no changes and any other path with an empty object", async () => {
    const answer = inboxFetch({
      kind: "ready",
      notifications: inboxNotificationsFixture(),
    });

    const delta = await answer(`${ORIGIN}${LIST_PATH}/delta`);
    expect(await delta.json()).toMatchObject({
      deletedInboxNotifications: [],
      inboxNotifications: [],
    });

    const other = await answer(`${ORIGIN}/v2/c/somewhere-else`);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({});
  });

  it("reports zero unread once every notification is read", async () => {
    const answer = inboxFetch({
      kind: "ready",
      notifications: inboxNotificationsFixture(true),
    });
    const count = await answer(`${ORIGIN}${LIST_PATH}/count`);
    expect(await count.json()).toEqual({ count: 0 });
  });

  it("answers 403 when Liveblocks refuses and never settles when pending", async () => {
    const forbidden = await inboxFetch({ kind: "forbidden" })(
      `${ORIGIN}${LIST_PATH}`
    );
    expect(forbidden.status).toBe(403);

    const pending = inboxFetch({ kind: "pending" })(`${ORIGIN}${LIST_PATH}`);
    expect(await Promise.race([pending, Promise.resolve(STILL_PENDING)])).toBe(
      STILL_PENDING
    );
  });
});

function readState() {
  const seen: { clerk: unknown; signIn: unknown } = {
    clerk: null,
    signIn: null,
  };
  function Probe() {
    seen.clerk = useClerk();
    seen.signIn = useSignIn().signIn;
    return null;
  }
  return { Probe, seen };
}

function mountWithDecorators(
  decorators: ReturnType<typeof withClerkState>[],
  Probe: () => null
) {
  const Composed = composeStory(
    { render: () => <Probe />, decorators },
    { title: "Tail/Auth probe" }
  );
  return render(<Composed />);
}

describe("withClerkState", () => {
  it("signs the user out and fakes a failed load, then puts every field back on unmount", () => {
    const { Probe, seen } = readState();
    const baseline = render(<Probe />);
    const originalUser = Reflect.get(seen.clerk as object, "user");
    expect(Reflect.get(seen.clerk as object, "loaded")).toBe(true);
    expect(Object.hasOwn(seen.clerk as object, "status")).toBe(false);
    baseline.unmount();

    const view = mountWithDecorators(
      [withClerkState({ loaded: false, signedOut: true, status: "error" })],
      Probe
    );
    expect(Reflect.get(seen.clerk as object, "loaded")).toBe(false);
    expect(Reflect.get(seen.clerk as object, "status")).toBe("error");
    expect(Reflect.get(seen.clerk as object, "user")).toBeNull();

    view.unmount();
    expect(Reflect.get(seen.clerk as object, "loaded")).toBe(true);
    // pins current behavior; looks odd because the stand-in never owned `status`, so undo deletes it
    expect(Object.hasOwn(seen.clerk as object, "status")).toBe(false);
    expect(Reflect.get(seen.clerk as object, "user")).toBe(originalUser);
  });

  it("merges user fields over the signed-in user and swaps the sso answer, both restored on unmount", async () => {
    const { Probe, seen } = readState();
    const originalSso = (() => {
      const baseline = render(<Probe />);
      const sso = Reflect.get(seen.signIn as object, "sso");
      baseline.unmount();
      return sso;
    })();
    const sso = vi.fn(() => Promise.resolve("redirecting"));

    const view = mountWithDecorators(
      [withClerkState({ sso, user: { lastName: "Tail" } })],
      Probe
    );
    const user = Reflect.get(seen.clerk as object, "user") as {
      firstName: string;
      lastName: string;
    };
    expect(user.lastName).toBe("Tail");
    expect(user.firstName).toBe("Dana");
    const swapped = Reflect.get(seen.signIn as object, "sso") as () => unknown;
    expect(await swapped()).toBe("redirecting");

    view.unmount();
    const restored = render(<Probe />);
    expect(Reflect.get(seen.signIn as object, "sso")).toBe(originalSso);
    expect(
      (Reflect.get(seen.clerk as object, "user") as { lastName: string })
        .lastName
    ).toBe("Reyes");
    restored.unmount();
  });
});

describe("withFastForward", () => {
  function timeoutDelays(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.map((call: unknown[]) => call[1]);
  }

  it("fires only the listed delays at once and restores the previous setTimeout on unmount", () => {
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((() => 0) as unknown as typeof setTimeout);
    const before = globalThis.setTimeout;
    const view = mountWithDecorators([withFastForward([5000])], () => null);
    expect(globalThis.setTimeout).not.toBe(before);

    globalThis.setTimeout(() => undefined, 5000);
    globalThis.setTimeout(() => undefined, 123);
    const listed = timeoutDelays(spy).slice(-2);
    expect(listed).toEqual([0, 123]);

    view.unmount();
    expect(globalThis.setTimeout).toBe(before);
  });

  it("leaves a setTimeout that someone else installed after it alone on unmount", () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (() => 0) as unknown as typeof setTimeout
    );
    const view = mountWithDecorators([withFastForward([5000])], () => null);
    const replacement = (() => 0) as unknown as typeof setTimeout;
    globalThis.setTimeout = replacement;

    view.unmount();
    // pins current behavior; looks odd because the decorator's own patch is dropped without being undone
    expect(globalThis.setTimeout).toBe(replacement);
  });
});

describe("BranchCellExamples", () => {
  it("throws naming the column when the Branches list has no such column", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(<BranchCellExamples columnId="no-such-column" examples={[]} />)
    ).toThrow(NO_SUCH_COLUMN);
  });
});

describe("buildStorySortOrder with a level that lists no groups", () => {
  it.each([
    ["an empty group list", []],
    ["no group list at all", undefined],
  ] as const)(
    "appends the level's v1.0 root bare for %s, with no children array behind it",
    (_label, groups) => {
      const baseline = buildStorySortOrder();
      Object.defineProperty(storybookLevelGroupOrder, EMPTY_LEVEL, {
        configurable: true,
        enumerable: true,
        value: groups,
      });

      const order = buildStorySortOrder();
      expect(order).toHaveLength(baseline.length + 1);
      expect(order.at(-1)).toBe(storybookBaselineRoot(EMPTY_LEVEL));
      expect(Array.isArray(order.at(-2))).toBe(true);
    }
  );
});
