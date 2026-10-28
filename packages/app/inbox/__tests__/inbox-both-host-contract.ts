import { RetiredInboxNotificationKind } from "@repo/api/src/types/retired-inbox-notification-kinds";
import type { BothHostRenderContract } from "@repo/app/shared/testing/both-host-render-contract";
import { foundOrAbsent } from "@repo/app/shared/testing/both-host-render-contract";
import { screen } from "@testing-library/react";
import type { InboxSurfaceNotification } from "../lib/inbox-notification-source";

/**
 * ISS-9406 — what `InboxSurfaceV2` owes its reader, whichever shell mounts it.
 *
 * AC1: equivalent notification records must render the same actor, kind,
 * timestamp and read state on both hosts. All four are asserted here against the
 * real notification chrome rather than a stub — the HEADLINE for kind and actor,
 * `data-unread` on the row for read state, `<time datetime>` for the instant. A
 * host mounts the surface and supplies nothing but its transport, so a
 * divergence in any of the four is a divergence in the records one produced.
 *
 * Kind off the HEADLINE and not off the row's `data-kind`, which is the obvious
 * locator and a false one: Liveblocks stamps it from the record and renders a
 * fallback row for a kind nobody registered, so deleting a kind leaves
 * `data-kind` green while the sentence that kind writes disappears.
 *
 * Only `web` mounts this today, and this contract deliberately carries NO
 * divergence entry: `apps/desktop` has no notification transport at all, PRD-702
 * owns building one, and a divergence excusing a shell nobody has built yet is
 * the sentence this runner exists to refuse. When that transport lands, its
 * suite supplies a `mount` and these cases run unchanged.
 */

export type InboxBothHostFixture = {
  readonly notifications: readonly InboxSurfaceNotification[];
  /**
   * Whether the host mounts with the actor treatment's gate open. Carried on the
   * fixture rather than fixed per contract, because the shipped default is
   * closed and both sides of it are states the reader is owed.
   */
  readonly actorRowsEnabled: boolean;
};

const ACTOR_ID = "user_emma";
/** Resolved by each host's own user resolver to this name. */
const ACTOR_NAME = "Emma Chen";

/**
 * A distinct instant per record, so "the timestamp reaches the row" cannot be
 * satisfied by one row's date rendered three times.
 */
const ASSIGNED_AT = "2026-09-01T10:00:00.000Z";
const MENTIONED_AT = "2026-09-02T11:30:00.000Z";
const AWAITING_AT = "2026-09-03T12:45:00.000Z";
const RETIRED_AT = "2026-09-04T13:15:00.000Z";

/**
 * One record of every kind the surface registers. Three, not one: a shell that
 * hard-codes a single row shape satisfies a one-record fixture. The
 * awaiting-input record is the READ one, so the unread check below has a
 * negative case.
 */
export const CONTRACT_INBOX_NOTIFICATIONS: readonly InboxSurfaceNotification[] =
  [
    inboxRecord("in_assignment", "$assignment", ASSIGNED_AT, null, {
      actorId: ACTOR_ID,
      entityTitle: "Fix session transcripts",
      entityType: "artifact",
      entityUrl: "/closedloop-ai/documents/iss-1",
    }),
    inboxRecord("in_mention", "$mention", MENTIONED_AT, null, {
      actorId: ACTOR_ID,
      commentPreview: "can you take a look?",
      entityTitle: "Nightly review",
      entityType: "session",
      entityUrl: "/closedloop-ai/sessions/ses-1",
    }),
    inboxRecord("in_awaiting", "$awaitingInput", AWAITING_AT, AWAITING_AT, {
      sessionTitle: "Overnight backfill",
      sessionUrl: "/closedloop-ai/sessions/ses-2",
    }),
  ];

/**
 * A stored record of a kind whose producer is gone (PRD-795). Liveblocks still
 * holds these until the deletion script runs; the surface must not list them.
 */
const RETIRED_KIND_RECORD = inboxRecord(
  "in_retired",
  RetiredInboxNotificationKind.LoopCompleted,
  RETIRED_AT,
  null,
  { loopTitle: "Weekly digest" }
);

/**
 * The headline each kind writes when nobody is named — the shipped default.
 * Written out: reading them off the row components would leave this green after
 * a kind stopped saying anything at all.
 */
const ACTORLESS_HEADLINES = [
  "You were assigned to artifact Fix session transcripts",
  "You were mentioned in a comment on session Nightly review",
  "Overnight backfill needs your input",
] as const;

/** The empty state's title, as both list bodies render it. */
const INBOX_EMPTY_TITLE = "No notifications yet";

/** What the two actor-bearing kinds say once the treatment is on. */
const ACTOR_HEADLINES = [
  `${ACTOR_NAME} assigned you artifact Fix session transcripts`,
  `${ACTOR_NAME} mentioned you in session Nightly review`,
] as const;

function inboxRecord(
  id: string,
  kind: string,
  notifiedAt: string,
  readAt: string | null,
  data: Record<string, string>
): InboxSurfaceNotification {
  // Liveblocks' own custom-kind record. The cast is confined here, so a host's
  // fixture cannot drift from the shape its rows read.
  return {
    activities: [{ createdAt: new Date(notifiedAt), data, id: `ac_${id}` }],
    id,
    kind,
    notifiedAt: new Date(notifiedAt),
    readAt: readAt === null ? null : new Date(readAt),
    subjectId: `sub_${id}`,
  } as unknown as InboxSurfaceNotification;
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

async function headlinesPresent(
  headlines: readonly string[]
): Promise<string | undefined> {
  for (const headline of headlines) {
    const found = await foundOrAbsent(() =>
      // An element's WHOLE text: a headline spans element boundaries, so the
      // per-node matcher never sees the sentence. Equality rather than
      // containment, because `<body>` contains every headline.
      screen.findAllByText(
        (_content, element) => normalize(element?.textContent) === headline
      )
    );
    if (found === undefined) {
      return `no element reads "${headline}"`;
    }
  }
  return undefined;
}

function instantsStamped({
  notifications,
}: InboxBothHostFixture): string | undefined {
  for (const record of notifications) {
    const instant = record.notifiedAt.toISOString();
    if (document.querySelector(`time[datetime="${instant}"]`) === null) {
      return `no row stamps the instant ${instant}`;
    }
  }
  return undefined;
}

/** Both directions: marking every row unread fails the read half. */
function readStateShown({
  notifications,
}: InboxBothHostFixture): string | undefined {
  for (const record of notifications) {
    const row = document.querySelector(`[data-kind="${record.kind}"]`);
    if (row === null) {
      return `the ${record.kind} record did not render at all`;
    }
    const shownUnread = row.hasAttribute("data-unread");
    const isUnread = record.readAt === null;
    if (shownUnread !== isUnread) {
      return isUnread
        ? `the unread ${record.kind} record is not shown as unread`
        : `the already-read ${record.kind} record is shown as unread`;
    }
  }
  return undefined;
}

/** Liveblocks wraps every list child in one of these, rendered or not. */
const LIST_ITEM_SELECTOR = ".lb-inbox-notification-list-item";

function retiredKindDropped({
  notifications,
}: InboxBothHostFixture): string | undefined {
  if (
    document.querySelector(
      `[data-kind="${RetiredInboxNotificationKind.LoopCompleted}"]`
    ) !== null
  ) {
    return "the retired-kind record rendered a row";
  }
  const listed = document.querySelectorAll(LIST_ITEM_SELECTOR).length;
  const expected = notifications.length - 1;
  if (listed !== expected) {
    return `listed ${listed} items, expected ${expected}`;
  }
  return undefined;
}

const CLOSED_ACTOR_GATE: InboxBothHostFixture = {
  actorRowsEnabled: false,
  notifications: CONTRACT_INBOX_NOTIFICATIONS,
};

export const INBOX_BOTH_HOST_CONTRACT: BothHostRenderContract<InboxBothHostFixture> =
  {
    surface: "Inbox surface v2",
    cases: [
      {
        fixture: CLOSED_ACTOR_GATE,
        name: "writes each kind's own headline",
        renderProblem: () => headlinesPresent(ACTORLESS_HEADLINES),
      },
      {
        fixture: CLOSED_ACTOR_GATE,
        name: "stamps each record's own notified instant",
        renderProblem: async (fixture) => instantsStamped(fixture),
      },
      {
        fixture: CLOSED_ACTOR_GATE,
        name: "separates the unread records from the read one",
        renderProblem: async (fixture) => readStateShown(fixture),
      },
      {
        fixture: {
          actorRowsEnabled: true,
          notifications: CONTRACT_INBOX_NOTIFICATIONS,
        },
        name: "names the actor on the kinds that carry one",
        renderProblem: () => headlinesPresent(ACTOR_HEADLINES),
      },
      {
        fixture: {
          actorRowsEnabled: false,
          notifications: [...CONTRACT_INBOX_NOTIFICATIONS, RETIRED_KIND_RECORD],
        },
        name: "lists no row for a retired kind",
        renderProblem: async (fixture) => retiredKindDropped(fixture),
      },
      {
        fixture: {
          actorRowsEnabled: false,
          notifications: [RETIRED_KIND_RECORD],
        },
        name: "shows the empty state when only retired kinds are stored",
        renderProblem: () => headlinesPresent([INBOX_EMPTY_TITLE]),
      },
    ],
  };
