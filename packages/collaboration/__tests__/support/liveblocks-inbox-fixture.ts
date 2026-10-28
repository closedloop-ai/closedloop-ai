/**
 * ISS-10010 — the Liveblocks setup both mark-all-read seams stand up.
 *
 * The wire test drives the raw client and the hook test drives the React hook,
 * but each needs the same vendor scaffolding: an id-token auth endpoint, a
 * fetch polyfill keyed on pathname, and an unread population larger than one
 * page. Kept in one module so an auth- or record-shape change lands on both
 * seams at once rather than updating one and leaving the other exercising
 * stale setup.
 */

export const INBOX_LIST_PATH = "/v2/c/inbox-notifications";
export const INBOX_READ_PATH = "/v2/c/inbox-notifications/read";

/** Above any page size the client currently asks for; asserted, not assumed. */
export const SEEDED_UNREAD = 60;

export const SEEDED_NOTIFIED_AT = "2026-09-01T10:00:00.000Z";

export type SeededNotification = {
  activities: { createdAt: string; data: Record<string, string>; id: string }[];
  id: string;
  kind: string;
  notifiedAt: string;
  readAt: string | null;
};

/** Identity carried by {@link idToken}, parameterised per seam. */
export type TokenIdentity = {
  readonly name: string;
  readonly userId: string;
};

/** The payload shape `sendAssignmentNotification` writes, one per record. */
export function seedUnreadNotifications(
  count: number,
  namespace: string
): SeededNotification[] {
  return Array.from({ length: count }, (_, index) => ({
    activities: [
      {
        createdAt: SEEDED_NOTIFIED_AT,
        data: {
          entityTitle: `Record ${index}`,
          entityType: "artifact",
          entityUrl: `/closedloop-ai/documents/doc-${index}`,
        },
        id: `ac_${namespace}_${index}`,
      },
    ],
    id: `in_${namespace}_${index}`,
    kind: "$assignment",
    notifiedAt: SEEDED_NOTIFIED_AT,
    readAt: null,
  }));
}

export function idToken({ name, userId }: TokenIdentity): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const segment = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "RS256", typ: "JWT" }),
    segment({
      exp: issuedAt + 3600,
      iat: issuedAt,
      k: "id",
      ui: { name },
      uid: userId,
    }),
    "unsigned",
  ].join(".");
}

export function requestHref(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * One page of `seeded`, modelled at whatever size the client asked for, so the
 * stub cannot disagree with the vendor about where the page ends.
 */
export function inboxListPage({
  limit,
  offset,
  seeded,
}: {
  limit: number;
  offset: number;
  seeded: readonly SeededNotification[];
}) {
  const page = seeded.slice(offset, offset + limit);
  return {
    groups: [],
    inboxNotifications: page,
    meta: {
      nextCursor: offset + page.length < seeded.length ? "cursor_next" : null,
      requestedAt: SEEDED_NOTIFIED_AT,
    },
    subscriptions: [],
    threads: [],
  };
}

export function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  );
}
