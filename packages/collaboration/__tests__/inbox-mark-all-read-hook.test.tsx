// @vitest-environment jsdom
import { useInboxNotifications } from "@liveblocks/react";
import { LiveblocksProvider } from "@liveblocks/react/suspense";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useMarkAllInboxNotificationsAsRead } from "../client/hooks";
import {
  INBOX_LIST_PATH,
  INBOX_READ_PATH,
  idToken,
  inboxListPage,
  jsonResponse,
  requestHref,
  SEEDED_UNREAD,
  seedUnreadNotifications,
} from "./support/liveblocks-inbox-fixture";

/**
 * ISS-10010 — the hop the wire test cannot see.
 *
 * `inbox-mark-all-read-scope.test.ts` pins what the CLIENT method puts on the
 * wire; the host binds the HOOK re-exported here. Between them sits vendor code
 * that wraps the call in an optimistic store update, and nothing else in the
 * repo pins that it still delegates to the population-scoped call: the host's
 * own suite mocks this module wholesale, so a hook that marked only the records
 * its store holds would leave every other layer green while "Mark all as read"
 * quietly became a lie.
 *
 * This is also the ONLY seam where a corpus can change the answer, which is why
 * the store is seeded here rather than left empty. `markAllInboxNotificationsAsRead`
 * on the raw client takes no argument and shares no state with
 * `getInboxNotifications`, so at the wire seam a populated client cannot make
 * the command narrow; the react store is the one layer that holds records a
 * page-scoped hook could enumerate. The drift shape most likely to slip past a
 * Liveblocks bump is exactly a hook that sends the sentinel while its store is
 * empty and an id list once it holds records, so this case fills the store
 * first and proves it holds one page out of a larger unread set.
 *
 * The seeding hook is the non-suspense `useInboxNotifications` because the
 * suspense twin never surfaces a value through `renderHook`. Both read the
 * client's single notification store, and the read-state assertion below is
 * what proves it: the command's optimistic update lands on the very records
 * this hook returned.
 */

const HOOK_IDENTITY = {
  name: "Hook Scope Test",
  userId: "user_hook_scope_test",
} as const;

const SEEDED = seedUnreadNotifications(SEEDED_UNREAD, "hook");

describe("Inbox mark-all-read hook delegation (ISS-10010)", () => {
  it("names no records even with a page already in its store", async () => {
    const bodies: unknown[] = [];
    let requestedLimit: number | null = null;

    const fetchStub: typeof fetch = (input, init) => {
      const method = init?.method ?? "GET";
      const { pathname, searchParams } = new URL(requestHref(input));
      if (method === "GET" && pathname === INBOX_LIST_PATH) {
        const limit = Number(searchParams.get("limit"));
        requestedLimit = limit;
        const offset = searchParams.get("cursor") === null ? 0 : limit;
        return jsonResponse(inboxListPage({ limit, offset, seeded: SEEDED }));
      }
      if (method === "POST" && pathname === INBOX_READ_PATH) {
        const raw = init?.body;
        bodies.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        return jsonResponse({});
      }
      // Anything else is not this case's subject, and answering it a shape
      // nothing stands behind is how a failed write passes as a clean one.
      return Promise.reject(
        new Error(`unstubbed request: ${method} ${pathname}`)
      );
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveblocksProvider
        authEndpoint={() => Promise.resolve({ token: idToken(HOOK_IDENTITY) })}
        polyfills={{ fetch: fetchStub }}
      >
        {children}
      </LiveblocksProvider>
    );

    const { result } = renderHook(
      () => ({
        markAllAsRead: useMarkAllInboxNotificationsAsRead(),
        received: useInboxNotifications(),
      }),
      { wrapper }
    );

    await waitFor(() =>
      expect(
        result.current.received.inboxNotifications?.length ?? 0
      ).toBeGreaterThan(0)
    );

    // The premise, not decoration: this store holds ONE page while the reader's
    // unread set is larger, so a hook narrowing to what it holds would have to
    // name ids here.
    const held = result.current.received.inboxNotifications ?? [];
    const limit = requestedLimit ?? 0;
    expect(limit).toBeGreaterThan(0);
    expect(held).toHaveLength(limit);
    expect(SEEDED.length).toBeGreaterThan(limit);
    expect(held.every((record) => record.readAt === null)).toBe(true);

    act(() => {
      result.current.markAllAsRead();
    });
    await waitFor(() => expect(bodies).toHaveLength(1));
    // The same literal the wire test asserts, reached through the hook the host
    // binds rather than the client method directly — and now with records in
    // the store that a page-scoped hook would have enumerated instead.
    expect(bodies[0]).toEqual({ inboxNotificationIds: "all" });
    // The command's optimistic update landed on the records the seeding hook
    // returned, which is what makes this ONE store rather than two.
    await waitFor(() => {
      const after = result.current.received.inboxNotifications ?? [];
      expect(after).toHaveLength(limit);
      expect(after.every((record) => record.readAt !== null)).toBe(true);
    });
  });
});
