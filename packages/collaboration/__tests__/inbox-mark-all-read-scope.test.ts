import { createClient } from "@liveblocks/client";
import { describe, expect, it } from "vitest";
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
 * ISS-10010 — what the Inbox's "Mark all as read" sends.
 *
 * No host calls `fetchMore`, so the surface holds ONE page while the reader's
 * unread set can be larger. What is pinned is that the command does not narrow
 * to that page: it posts the sentinel `"all"` and never enumerates the records
 * the client happens to hold. The second case is the contrast — the per-record
 * path reaches the SAME endpoint carrying an id list, so "scoped to what we
 * fetched" is a shape this endpoint can express and the sentinel is a protocol
 * choice rather than the only thing it accepts.
 *
 * What the seeded page here does and does NOT buy. It pins the client's own
 * paging — the limit it sends, the cap it honours, the cursor it is handed —
 * and that is why `SEEDED_UNREAD` sits above the page size. It does NOT make
 * case 1 harder to pass: `markAllInboxNotificationsAsRead` takes no argument
 * and shares no state with `getInboxNotifications`, so at THIS layer there is
 * no store for a page to narrow and a seed of zero would assert the same
 * literal. The seam that holds records is the react store, and the
 * populated-store case lives in the sibling
 * `inbox-mark-all-read-hook.test.tsx`, which drives `useInboxNotifications`
 * through the same provider before firing the command.
 *
 * Two further things this canNOT establish. That Liveblocks resolves `"all"` to
 * the reader's whole unread set: the service is stubbed, so that half is the
 * vendor's documented contract, relied on and not asserted. And that the web
 * host reaches this call at all: the host binds the HOOK
 * (`useMarkAllInboxNotificationsAsRead`), whose delegation to this client
 * method is vendor-internal, and whose binding is pinned by the host's own
 * suite under `apps/app/.../inbox/__tests__/page.test.tsx`.
 *
 * A red here on a Liveblocks bump is therefore a vendor protocol change, not a
 * product regression. The page boundary is taken from the `limit` the client
 * actually sends rather than written down, because a figure copied from the
 * vendor's own docs was already wrong once: its JSDoc says 20 where
 * `getInboxNotifications` sends 50.
 */

type RecordedRequest = {
  body: { inboxNotificationIds?: unknown } | undefined;
  method: string;
  path: string;
};

/**
 * `namespace` tags this harness's record ids. Each case builds its own harness,
 * so the ids cannot cross between them; what the tag buys is a failure message
 * that names which case's records a bad payload carried, rather than two
 * identical id lists a reader has to disambiguate by eye.
 */
function createHarness(namespace: string) {
  const seeded = seedUnreadNotifications(SEEDED_UNREAD, namespace);
  const requests: RecordedRequest[] = [];
  let requestedLimit: number | null = null;

  const fetchStub: typeof fetch = (input, init) => {
    const method = init?.method ?? "GET";
    const { pathname, searchParams } = new URL(requestHref(input));
    const rawBody = init?.body;
    requests.push({
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
      method,
      path: pathname,
    });

    if (method === "GET" && pathname === INBOX_LIST_PATH) {
      // The cap, modelled at whatever size the client asked for, so the stub
      // cannot disagree with the vendor about where the page ends.
      const limit = Number(searchParams.get("limit"));
      requestedLimit = limit;
      const offset = searchParams.get("cursor") === null ? 0 : limit;
      return jsonResponse(inboxListPage({ limit, offset, seeded }));
    }
    if (method === "POST" && pathname === INBOX_READ_PATH) {
      return jsonResponse({});
    }
    // Rejects rather than answering a shape nothing stands behind: an
    // unmodelled 200 would let a failed read pass as "nothing to mark".
    return Promise.reject(
      new Error(`unstubbed Liveblocks request: ${method} ${pathname}`)
    );
  };

  const client = createClient({
    authEndpoint: () =>
      Promise.resolve({
        token: idToken({ name: "Scope Test", userId: "user_scope_test" }),
      }),
    polyfills: { fetch: fetchStub },
  });

  return { client, pageLimit: () => requestedLimit, requests, seeded };
}

function readWrites(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    (request) => request.method === "POST" && request.path === INBOX_READ_PATH
  );
}

describe("Inbox mark-all-read scope (ISS-10010)", () => {
  it("names no records, so the fetched page cannot narrow it", async () => {
    const { client, pageLimit, requests, seeded } = createHarness("all");

    const page = await client.getInboxNotifications();
    const limit = pageLimit() ?? 0;

    // The client's own paging, pinned: it caps, and it is handed a cursor it
    // never follows. Fails loudly if the vendor's page size ever grows past the
    // seed, instead of quietly collapsing page and population into one set.
    expect(limit).toBeGreaterThan(0);
    expect(seeded.length).toBeGreaterThan(limit);
    expect(page.inboxNotifications).toHaveLength(limit);
    expect(page.nextCursor).not.toBeNull();

    await client.markAllInboxNotificationsAsRead();

    const writes = readWrites(requests);
    expect(writes).toHaveLength(1);
    // The literal is the test, and `toEqual` is exact: an id list smuggled in
    // beside the sentinel fails here too.
    expect(writes[0]?.body).toEqual({ inboxNotificationIds: "all" });
  });

  it("sends the ids themselves when a caller does name records", async () => {
    const { client, pageLimit, requests } = createHarness("named");

    const page = await client.getInboxNotifications();
    expect(page.inboxNotifications).toHaveLength(pageLimit() ?? 0);

    // Driven from the PARSED records, so the ids asserted below are the ones a
    // caller really holds rather than the fixture's own strings.
    const named = page.inboxNotifications
      .slice(0, 3)
      .map((record) => record.id);
    expect(named).toHaveLength(3);
    await Promise.all(
      named.map((id) => client.markInboxNotificationAsRead(id))
    );

    const writes = readWrites(requests);
    expect(writes.length).toBeGreaterThan(0);
    // The contrast for the case above: the same endpoint does carry id lists,
    // so the sentinel is a choice and not the only shape it accepts.
    const scoped: unknown[] = writes.flatMap((write) =>
      Array.isArray(write.body?.inboxNotificationIds)
        ? write.body.inboxNotificationIds
        : []
    );
    expect(scoped).toEqual(expect.arrayContaining(named));
  });
});
