import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { type Tag, TagColor } from "@repo/api/src/types/tag";
import type { User } from "@repo/api/src/types/user";
import { FeedItemKind } from "@repo/app/documents/components/feed-sidebar/feed-item";
import type { ActivityLinkLookups } from "@repo/app/documents/components/feed-sidebar/sources/activity-formatting";
import {
  ACTIVITY_SOURCE_ID,
  ActivityArtifactKind,
  type ActivityFeedItem,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-types";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { tagKeys } from "@repo/app/tags/hooks/use-tags";
import { userKeys } from "@repo/app/users/hooks/use-users";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "./activity-timeline";

/**
 * The Activity catalog fixtures (ISS-12117): one row per item the ISS-10994
 * activity capture inventory lists (C01–C31, the three Document projections
 * P1, P2 and P4, and a host-supplied comment CM), plus the Document, Session and
 * Branch example timelines from Nerys's brief.
 *
 * Every row is a feed item in the exact shape the write path stores and the
 * read API returns, copied from the inventory's synthetic JSON. The ids are
 * the inventory's fake UUIDs (`00000000-0000-7000-8000-…`); no real data.
 * The people (Emily Carter, Jake Morrison, Ryan Brooks), projects (Atlas,
 * Orion) and tags are invented for the stories.
 *
 * Timestamps are fixed relative to {@link ACTIVITY_FIXTURE_NOW}, and every
 * story passes that clock to the timeline, so "2 hours ago" stays "2 hours
 * ago" and dates older than a week show as dates.
 */

/** The fixtures' clock: stories pass it as the timeline's `now`. */
export const ACTIVITY_FIXTURE_NOW = new Date("2026-10-07T15:00:00.000Z");

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function ago(ms: number): Date {
  return new Date(ACTIVITY_FIXTURE_NOW.getTime() - ms);
}

const fakeId = (suffix: string) => `00000000-0000-7000-8000-${suffix}`;

function person(
  id: string,
  firstName: string,
  lastName: string,
  email: string
): User {
  return { id, firstName, lastName, email, avatarUrl: null } as User;
}

export const EMILY = person(
  fakeId("000000000101"),
  "Emily",
  "Carter",
  "emily@example.com"
);
export const JAKE = person(
  fakeId("000000000102"),
  "Jake",
  "Morrison",
  "jake@example.com"
);
export const RYAN = person(
  fakeId("000000000103"),
  "Ryan",
  "Brooks",
  "ryan@example.com"
);

/** An id no directory knows: the "Missing user" story's member who left. */
export const DEPARTED_USER_ID = fakeId("000000000199");

export const ATLAS = {
  id: fakeId("000000000120"),
  name: "Atlas",
} as ProjectWithDetails;
export const ORION = {
  id: fakeId("000000000121"),
  name: "Orion",
} as ProjectWithDetails;

function tag(suffix: string, name: string, color: TagColor): Tag {
  return { id: fakeId(suffix), name, color } as Tag;
}

export const FRONTEND_TAG = tag("000000000130", "frontend", TagColor.Blue);
export const DESIGN_TAG = tag("000000000131", "design", TagColor.Purple);
export const BACKEND_TAG = tag("000000000132", "backend", TagColor.Green);
export const AUTH_TAG = tag("000000000133", "auth", TagColor.Amber);
export const RELEASE_TAG = tag("000000000134", "release", TagColor.Teal);

/** The org's tag catalog the fixture rows name. */
export const ACTIVITY_TAGS: readonly Tag[] = [
  FRONTEND_TAG,
  DESIGN_TAG,
  BACKEND_TAG,
  AUTH_TAG,
  RELEASE_TAG,
];

/**
 * Seeds the org-user, project and tag directories the production card
 * resolves ids against, through the Storybook app-core harness
 * (`parameters.appCore.queryData`).
 */
export const ACTIVITY_QUERY_DATA = [
  [userKeys.organizationUsers(), [EMILY, JAKE, RYAN]],
  [projectKeys.list({}), [ATLAS, ORION]],
  [tagKeys.list({}), ACTIVITY_TAGS],
] as const;

/**
 * Portraits for the timeline's photo stories, by person (ISS-12330): copies
 * of the repo's seed portraits (DiceBear Lorelei illustrations, CC0) in
 * `apps/storybook/public/seed-avatars/` (see its README), served by the
 * Storybook at `seed-avatars/`.
 * Illustrations, not photos of real people. Relative, so they resolve under
 * the hosted Storybook's `/storybook/` path too.
 */
export const ACTIVITY_FIXTURE_PHOTOS: Readonly<Record<string, string>> = {
  [EMILY.id]: "seed-avatars/elenamorales.svg",
  [JAKE.id]: "seed-avatars/dreyes.svg",
  [RYAN.id]: "seed-avatars/tlindqvist.svg",
};

/**
 * `ACTIVITY_QUERY_DATA` with a photo for each of `withPhotos`; everyone else
 * keeps no photo and reads as initials.
 */
export function activityQueryDataWithPhotos(withPhotos: readonly User[]) {
  const photoIds = new Set(withPhotos.map((user) => user.id));
  const users = [EMILY, JAKE, RYAN].map((user) => ({
    ...user,
    avatarUrl: photoIds.has(user.id)
      ? (ACTIVITY_FIXTURE_PHOTOS[user.id] ?? null)
      : null,
  }));
  const [, ...directories] = ACTIVITY_QUERY_DATA;
  return [[userKeys.organizationUsers(), users], ...directories] as const;
}

export const PRD_751 = fakeId("000000000150");
const ISS_10843 = fakeId("000000000151");

/**
 * The host links the stories supply (`ActivityTimeline`'s `links`). Story
 * hrefs are fragments: they show a link without leaving Storybook.
 */
export const ACTIVITY_FIXTURE_LINKS: ActivityLinkLookups = {
  relatedArtifact: (id) => {
    if (id === PRD_751) {
      return {
        key: "PRD-751",
        title: "Activity timeline requirements",
        href: "#PRD-751",
      };
    }
    if (id === ISS_10843) {
      return {
        key: "ISS-10843",
        title: "Activity tab design",
        href: "#ISS-10843",
      };
    }
    return null;
  },
  versionHref: (version) => `#version-${version}`,
  reportHref: ({ reportType }) => `#report-${reportType.toLowerCase()}`,
};

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/** Who wrote a row: a person, an API key owned by a person, or the system. */
export type FixtureActor = User | "system" | { apiKeyOwner: User };

function feedActor(actor: FixtureActor): ActivityFeedActor {
  if (actor === "system") {
    return { kind: ActivityFeedActorKind.System, id: null };
  }
  if ("apiKeyOwner" in actor) {
    return { kind: ActivityFeedActorKind.Agent, id: actor.apiKeyOwner.id };
  }
  return { kind: ActivityFeedActorKind.Human, id: actor.id };
}

type EventShape = Pick<
  ArtifactActivityFeedItem,
  "action" | "after" | "before"
> &
  Partial<Pick<ArtifactActivityFeedItem, "payload" | "source">>;

let sequence = 0;

export function activity(
  actor: FixtureActor,
  createdAt: Date,
  event: EventShape
): ActivityTimelineRow {
  sequence += 1;
  const source = event.source ?? ActivityFeedItemSource.Event;
  const id = `${source}:${fakeId(String(sequence).padStart(12, "9"))}`;
  const item: ActivityFeedItem = {
    id,
    kind: FeedItemKind.Activity,
    sourceId: ACTIVITY_SOURCE_ID,
    createdAt,
    event: {
      id,
      source,
      action: event.action,
      actor: feedActor(actor),
      before: event.before,
      after: event.after,
      payload: event.payload ?? null,
      createdAt,
    },
  };
  return { kind: ActivityTimelineRowKind.Activity, item };
}

export function comment(
  author: User,
  createdAt: Date,
  threadId: string,
  body: string | null,
  options: { unavailable?: boolean } = {}
): ActivityTimelineRow {
  return {
    kind: ActivityTimelineRowKind.Comment,
    id: `comment:${threadId}`,
    authorId: author.id,
    createdAt,
    href: `#comment-${threadId}`,
    body,
    unavailable: options.unavailable ?? false,
  };
}

export function field(name: string, value: string | null) {
  return { field: name, value };
}

/** The receipt shape a bulk write leaves. */
export function bulk(name: string, value: string | null) {
  return {
    field: name,
    value,
    surface: "bulk",
    result: "committed",
    commitGroupId: fakeId("000000000140"),
  };
}

export const status = ArtifactActivityAction.StatusChange;
export const fieldChange = ArtifactActivityAction.FieldChange;
export const assignment = ArtifactActivityAction.Assignment;

export function versionRow(actor: FixtureActor, at: Date, version: number) {
  return activity(actor, at, {
    source: ActivityFeedItemSource.VersionCreated,
    action: null,
    before: null,
    after: null,
    payload: { version },
  });
}

export function derivationRow(
  at: Date,
  direction: "produced" | "produced_from",
  relatedArtifactId: string
) {
  return activity("system", at, {
    source: ActivityFeedItemSource.Derivation,
    action: null,
    before: null,
    after: null,
    payload: { direction, relatedArtifactId },
  });
}

export function evaluationRow(at: Date) {
  return activity("system", at, {
    source: ActivityFeedItemSource.Evaluation,
    action: null,
    before: null,
    after: null,
    payload: { reportType: "PLAN" },
  });
}

// ---------------------------------------------------------------------------
// The catalog: one entry per inventory row
// ---------------------------------------------------------------------------

export const ActivityCatalogId = {
  C01: "C01",
  C02: "C02",
  C03: "C03",
  C04: "C04",
  C05: "C05",
  C06: "C06",
  C07: "C07",
  C08: "C08",
  C09: "C09",
  C10: "C10",
  C11: "C11",
  C12: "C12",
  C13: "C13",
  C14: "C14",
  C15: "C15",
  C16: "C16",
  C17: "C17",
  C18: "C18",
  C19: "C19",
  C20: "C20",
  C21: "C21",
  C22: "C22",
  C23: "C23",
  C24: "C24",
  C25: "C25",
  C26: "C26",
  C27: "C27",
  C28: "C28",
  C29: "C29",
  C30: "C30",
  C31: "C31",
  P1: "P1",
  P2: "P2",
  P4: "P4",
} as const;
export type ActivityCatalogId =
  (typeof ActivityCatalogId)[keyof typeof ActivityCatalogId];

/** Where a captured item can be read today (ISS-10994; story docs only). */
export const ActivityAvailability = {
  DocumentFeed:
    "On main through GET /documents/[id]/activity (the Document feed).",
  SessionBranchFeed:
    "Persisted on main; readable only through PR #8368's Session and Branch activity endpoints.",
  Pr8368Only: "Captured only with PR #8368 (single Branch tag receipts).",
  NotInFeed:
    "Stored on Sessions but excluded from the V1 feed: not in feed yet.",
  Mixed:
    "Document rows on main through GET /documents/[id]/activity; Session and Branch rows readable only through PR #8368's endpoints.",
} as const;

export type ActivityCatalogEntry = {
  id: ActivityCatalogId;
  /** The inventory's name for the item. */
  name: string;
  artifactKind: ActivityArtifactKind;
  documentType?: DocumentType;
  availability: string;
  /** Anything else a reader of the story docs needs to know about the row. */
  note?: string;
  row: ActivityTimelineRow;
};

/**
 * C06 and C07 store identical rows (System, `status_change`, bare strings), so
 * the card cannot say which writer it was.
 */
const SESSION_SYSTEM_STATUS_NOTE =
  "The source (desktop ingest or the stale-session reaper) is not recorded on the row yet, so the card states no cause. Engineering follow-up: record the source.";

/** Catalog cards sit two hours back, so the time reads relative. */
const CARD_AT = ago(2 * HOUR);

function entry(
  id: ActivityCatalogId,
  name: string,
  artifactKind: ActivityArtifactKind,
  availability: string,
  row: ActivityTimelineRow
): ActivityCatalogEntry {
  return artifactKind === ActivityArtifactKind.Document
    ? {
        id,
        name,
        artifactKind,
        availability,
        row,
        documentType: DocumentType.Feature,
      }
    : { id, name, artifactKind, availability, row };
}

function withNote(
  note: string,
  catalogEntry: ActivityCatalogEntry
): ActivityCatalogEntry {
  return { ...catalogEntry, note };
}

const DOC = ActivityArtifactKind.Document;
const SESSION = ActivityArtifactKind.Session;
const BRANCH = ActivityArtifactKind.Branch;
const A = ActivityAvailability;

export const ACTIVITY_CATALOG: Readonly<
  Record<ActivityCatalogId, ActivityCatalogEntry>
> = {
  C01: entry(
    "C01",
    "Document created",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: ArtifactActivityAction.Creation,
      before: null,
      after: { status: "DRAFT", title: "Activity tab V1" },
    })
  ),
  C02: entry(
    "C02",
    "Single status edit",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: status,
      before: "DRAFT",
      after: "IN_REVIEW",
    })
  ),
  C03: entry(
    "C03",
    "Bulk status move (or undo)",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: status,
      before: field("status", "TODO"),
      after: bulk("status", "IN_PROGRESS"),
    })
  ),
  C04: entry(
    "C04",
    "Dependent auto-unblocked",
    DOC,
    A.DocumentFeed,
    activity("system", CARD_AT, {
      action: status,
      before: "BLOCKED",
      after: "TODO",
    })
  ),
  C05: entry(
    "C05",
    "Session status via grouping write",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: status,
      before: "active",
      after: "inactive",
    })
  ),
  C06: withNote(
    SESSION_SYSTEM_STATUS_NOTE,
    entry(
      "C06",
      "Session status by ingest",
      SESSION,
      A.SessionBranchFeed,
      activity("system", CARD_AT, {
        action: status,
        before: "active",
        after: "inactive",
      })
    )
  ),
  C07: withNote(
    SESSION_SYSTEM_STATUS_NOTE,
    entry(
      "C07",
      "Stale session reaped",
      SESSION,
      A.SessionBranchFeed,
      activity("system", CARD_AT, {
        action: status,
        before: "active",
        after: "error",
      })
    )
  ),
  C08: entry(
    "C08",
    "Assignee changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: assignment,
      before: field("assigneeId", null),
      after: field("assigneeId", JAKE.id),
    })
  ),
  C09: entry(
    "C09",
    "Approver changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: assignment,
      before: field("approverId", EMILY.id),
      after: field("approverId", RYAN.id),
    })
  ),
  C10: entry(
    "C10",
    "Session owner changed",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: assignment,
      before: field("ownerUserId", EMILY.id),
      after: field("ownerUserId", JAKE.id),
    })
  ),
  C11: entry(
    "C11",
    "Session owners bulk-assigned",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: assignment,
      before: field("ownerUserId", null),
      after: bulk("ownerUserId", JAKE.id),
    })
  ),
  C12: entry(
    "C12",
    "Title changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("title", "Old title"),
      after: field("title", "Revised title"),
    })
  ),
  C13: entry(
    "C13",
    "Due date changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("dueDate", null),
      after: field("dueDate", "2026-10-12T00:00:00.000Z"),
    })
  ),
  C14: entry(
    "C14",
    "Priority changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("priority", "LOW"),
      after: field("priority", "HIGH"),
    })
  ),
  C15: entry(
    "C15",
    "Priorities bulk-changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("priority", "LOW"),
      after: bulk("priority", "HIGH"),
    })
  ),
  C16: entry(
    "C16",
    "Session priority changed",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("priority", "MEDIUM"),
      after: field("priority", "HIGH"),
    })
  ),
  C17: entry(
    "C17",
    "Branch priority changed",
    BRANCH,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("priority", "MEDIUM"),
      after: field("priority", "HIGH"),
    })
  ),
  C18: entry(
    "C18",
    "Session priority seeded by sync",
    SESSION,
    A.SessionBranchFeed,
    activity("system", CARD_AT, {
      action: fieldChange,
      before: field("priority", null),
      after: field("priority", "MEDIUM"),
    })
  ),
  C19: entry(
    "C19",
    "Document project changed",
    DOC,
    A.DocumentFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("projectId", ATLAS.id),
      after: field("projectId", ORION.id),
    })
  ),
  C20: entry(
    "C20",
    "Batch move between projects",
    DOC,
    A.Mixed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("projectId", ATLAS.id),
      after: bulk("projectId", ORION.id),
    })
  ),
  C21: entry(
    "C21",
    "Session project changed",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("projectId", ATLAS.id),
      after: field("projectId", ORION.id),
    })
  ),
  C22: entry(
    "C22",
    "Session project changed by ingest",
    SESSION,
    A.SessionBranchFeed,
    activity("system", CARD_AT, {
      action: fieldChange,
      before: field("projectId", null),
      after: field("projectId", ORION.id),
    })
  ),
  C23: entry(
    "C23",
    "Session renamed",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("name", "Old name"),
      after: field("name", "New name"),
    })
  ),
  C24: entry(
    "C24",
    "Session name seeded by sync",
    SESSION,
    A.SessionBranchFeed,
    activity("system", CARD_AT, {
      action: fieldChange,
      before: field("name", null),
      after: field("name", "Refactor auth middleware"),
    })
  ),
  C25: entry(
    "C25",
    "Tag added in batch",
    DOC,
    A.Mixed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: null,
      after: bulk("tag", FRONTEND_TAG.id),
    })
  ),
  C26: entry(
    "C26",
    "Single Session tag added",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("tag", null),
      after: field("tag", FRONTEND_TAG.id),
    })
  ),
  C27: entry(
    "C27",
    "Single Session tag removed",
    SESSION,
    A.SessionBranchFeed,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("tag", FRONTEND_TAG.id),
      after: field("tag", null),
    })
  ),
  C28: entry(
    "C28",
    "Single Branch tag added (PR #8368)",
    BRANCH,
    A.Pr8368Only,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("tag", null),
      after: field("tag", FRONTEND_TAG.id),
    })
  ),
  C29: entry(
    "C29",
    "Single Branch tag removed (PR #8368)",
    BRANCH,
    A.Pr8368Only,
    activity(EMILY, CARD_AT, {
      action: fieldChange,
      before: field("tag", FRONTEND_TAG.id),
      after: field("tag", null),
    })
  ),
  C30: entry(
    "C30",
    "Monitored branch target retained",
    SESSION,
    A.NotInFeed,
    activity("system", CARD_AT, {
      action: ArtifactActivityAction.MonitoredActivityRetained,
      before: null,
      after: {
        kind: "branch",
        repositoryFullName: "example/repo",
        branchName: "feature/auth-refactor",
        url: "https://github.com/example/repo/tree/feature%2Fauth-refactor",
        eventKind: "agent_read",
        occurredAt: ago(2 * HOUR + 2 * MINUTE).toISOString(),
        completeness: "complete",
        disposition: "repository_out_of_scope",
      },
    })
  ),
  C31: entry(
    "C31",
    "Monitored PR target retained",
    SESSION,
    A.NotInFeed,
    activity("system", CARD_AT, {
      action: ArtifactActivityAction.MonitoredActivityRetained,
      before: null,
      after: {
        kind: "pull_request",
        repositoryFullName: "example/repo",
        prNumber: 123,
        url: "https://github.com/example/repo/pull/123",
        eventKind: "agent_action",
        occurredAt: ago(2 * HOUR + 2 * MINUTE).toISOString(),
        completeness: "complete",
        disposition: "repository_out_of_scope",
      },
    })
  ),
  P1: entry(
    "P1",
    "version_created (projection)",
    DOC,
    A.DocumentFeed,
    versionRow(EMILY, CARD_AT, 2)
  ),
  P2: entry(
    "P2",
    "derivation (projection)",
    DOC,
    A.DocumentFeed,
    derivationRow(CARD_AT, "produced", PRD_751)
  ),
  P4: entry(
    "P4",
    "evaluation (projection)",
    DOC,
    A.DocumentFeed,
    evaluationRow(CARD_AT)
  ),
};

// ---------------------------------------------------------------------------
// Variants: one item, every actor kind, and the edge cases
// ---------------------------------------------------------------------------

/** C02 by a person, through Emily's API key, and by the system. */
export const C02_ACTOR_VARIANTS = {
  human: activity(EMILY, CARD_AT, {
    action: status,
    before: "DRAFT",
    after: "IN_REVIEW",
  }),
  agent: activity({ apiKeyOwner: EMILY }, CARD_AT, {
    action: status,
    before: "DRAFT",
    after: "IN_REVIEW",
  }),
  system: activity("system", CARD_AT, {
    action: status,
    before: "DRAFT",
    after: "IN_REVIEW",
  }),
} as const;

/** A title change long enough to truncate on both sides. */
export const LONG_VALUE_ROW = activity(EMILY, CARD_AT, {
  action: fieldChange,
  before: field("title", "Activity tab design for every artifact detail page"),
  after: field(
    "title",
    "Design a reusable GitHub-inspired Activity timeline for the four-tab artifact shell across documents, branches and sessions"
  ),
});

/** An assignment by, and to, a member who has since left the org. */
export const MISSING_USER_ROW = activity(
  { id: DEPARTED_USER_ID } as User,
  CARD_AT,
  {
    action: assignment,
    before: field("assigneeId", null),
    after: field("assigneeId", DEPARTED_USER_ID),
  }
);

// ---------------------------------------------------------------------------
// Comments (CM)
// ---------------------------------------------------------------------------

export const COMMENT_SHORT = comment(
  JAKE,
  CARD_AT,
  "cm-short",
  "Looks good. Can we keep the actor avatar on the line?"
);

export const COMMENT_LONG = comment(
  RYAN,
  CARD_AT,
  "cm-long",
  [
    "I went through the whole timeline on a narrow window and the line holds up.",
    "Two things to check before handoff: the bulk suffix should stay muted so the actor stays the first thing you read, and comment boxes should never grow a reply box, since this is an audit trail.",
    "Also worth confirming with Cosimo and Daveth which collapse rules they want for V2, because repeated rows from one person get long on busy issues.",
    "Last, the load more button should sit at the end of the list.",
  ].join("\n")
);

export const COMMENT_UNAVAILABLE = comment(EMILY, CARD_AT, "cm-gone", null, {
  unavailable: true,
});

/** The read API pages newest first; a host renders rows in that order. */
export function newestFirst(
  rows: readonly ActivityTimelineRow[]
): readonly ActivityTimelineRow[] {
  return [...rows].reverse();
}
