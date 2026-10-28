import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { LiveblocksProvider } from "@repo/collaboration/client/hooks";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
} from "@repo/collaboration/client/user-resolvers";
import type { ReactNode } from "react";
import {
  liveAppShellRoutes,
  organizationUsersFixture,
} from "./live-app-fixtures";

// The live Inbox (`apps/app/.../inbox/inbox-host.tsx`) reads its rows, unread
// count and delta from Liveblocks over HTTP, through the LiveblocksProvider the
// authenticated layout mounts (`TopLevelCollaborationProvider`). Storybook has
// no Liveblocks, so `LiveblocksInbox` mounts the same provider with the same
// user resolvers and answers the client's `/v2/c/inbox-notifications*` reads
// through its `fetch` polyfill, the way `e2e/helpers/inbox-liveblocks-fixture.ts`
// answers them for the live app. Nothing leaves the browser.

const BASE64_PLUS = /\+/g;
const BASE64_SLASH = /\//g;
const BASE64_PADDING = /=+$/;

function base64Url(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(BASE64_PLUS, "-")
    .replace(BASE64_SLASH, "_")
    .replace(BASE64_PADDING, "");
}

/**
 * A Liveblocks ID token. The client only base64-decodes the middle segment and
 * needs `k` plus numeric `iat`/`exp`; the signature is never checked.
 */
function idToken(): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  return [
    base64Url({ alg: "RS256", typ: "JWT" }),
    base64Url({
      exp: issuedAt + 3600,
      iat: issuedAt,
      k: "id",
      uid: "user_test",
    }),
    "storybook-unsigned",
  ].join(".");
}

type WireNotification = {
  activities: Array<{
    createdAt: string;
    data: Record<string, string>;
    id: string;
  }>;
  id: string;
  kind: string;
  notifiedAt: string;
  readAt: string | null;
  subjectId: string;
};

function notification(
  id: string,
  kind: string,
  minutesAgo: number,
  read: boolean,
  data: Record<string, string>
): WireNotification {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    activities: [{ createdAt: at, data, id: `ac_${id}` }],
    id,
    kind,
    notifiedAt: at,
    readAt: read ? at : null,
    subjectId: `sub_${id}`,
  };
}

/** One of every row kind the Inbox renders; the oldest one already read. */
export function inboxNotificationsFixture(allRead = false): WireNotification[] {
  return [
    notification("in_assignment", "$assignment", 6, allRead, {
      actorId: "user_emma",
      entityTitle: "Fix session transcripts truncating at 2 MB",
      entityType: "artifact",
      entityUrl: "/org-test/documents/iss-1042",
    }),
    notification("in_mention", "$mention", 55, allRead, {
      actorId: "user_marcus",
      commentPreview: "can you take a look at the retry loop before we ship?",
      entityTitle: "Nightly dependency review",
      entityType: "session",
      entityUrl: "/org-test/sessions/ses_nightly_review",
    }),
    notification("in_awaiting", "$awaitingInput", 180, allRead, {
      sessionTitle: "Overnight backfill of usage rollups",
      sessionUrl: "/org-test/sessions/ses_backfill",
    }),
    notification("in_assignment_2", "$assignment", 420, true, {
      actorId: "user_priya",
      entityTitle: "Settings: members table empty state",
      entityType: "artifact",
      entityUrl: "/org-test/documents/iss-1057",
    }),
  ];
}

export type InboxLiveblocksState =
  /** Rows and an unread count. */
  | { kind: "ready"; notifications: WireNotification[] }
  /** The reads never settle. */
  | { kind: "pending" }
  /** Liveblocks refuses the token. */
  | { kind: "forbidden" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function liveblocksFetch(state: InboxLiveblocksState): typeof fetch {
  return (input) => {
    if (state.kind === "pending") {
      return new Promise<Response>(() => undefined);
    }
    if (state.kind === "forbidden") {
      return Promise.resolve(json({ error: "FORBIDDEN" }, 403));
    }
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const requestedAt = new Date().toISOString();
    const { notifications } = state;
    switch (url.pathname) {
      case "/v2/c/inbox-notifications":
        return Promise.resolve(
          json({
            groups: [],
            inboxNotifications: notifications,
            meta: { nextCursor: null, requestedAt },
            subscriptions: [],
            threads: [],
          })
        );
      case "/v2/c/inbox-notifications/count":
        return Promise.resolve(
          json({ count: notifications.filter((n) => n.readAt === null).length })
        );
      case "/v2/c/inbox-notifications/delta":
        return Promise.resolve(
          json({
            deletedInboxNotifications: [],
            deletedSubscriptions: [],
            deletedThreads: [],
            groups: [],
            inboxNotifications: [],
            meta: { requestedAt },
            subscriptions: [],
            threads: [],
          })
        );
      default:
        return Promise.resolve(json({}));
    }
  };
}

/** The authenticated layout's Liveblocks provider, answered from `state`. */
export function LiveblocksInbox({
  children,
  state,
}: {
  children: ReactNode;
  state: InboxLiveblocksState;
}) {
  return (
    <LiveblocksProvider
      authEndpoint={() => Promise.resolve({ token: idToken() })}
      polyfills={{ fetch: liveblocksFetch(state) }}
      resolveMentionSuggestions={createResolveMentionSuggestions(
        organizationUsersFixture
      )}
      resolveUsers={createResolveUsers(organizationUsersFixture)}
    >
      {children}
    </LiveblocksProvider>
  );
}

export const inboxApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  { method: "GET", path: "/users", respond: () => organizationUsersFixture },
];
