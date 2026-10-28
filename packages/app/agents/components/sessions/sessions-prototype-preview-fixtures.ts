import { Harness } from "@repo/api/src/types/agent-component";
import {
  type AgentSessionListItem,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  type TraceCommentReply,
  traceCommentDraftSchema,
  traceCommentReplyDraftSchema,
  traceCommentUpdateSchema,
} from "@repo/api/src/types/comment";
import { Priority } from "@repo/api/src/types/common";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { toSessionInstant } from "@repo/app/agents/lib/session-duration";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { agentSessionToSessionTableRow } from "@repo/app/agents/lib/session-table-row";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { createAgentSessionDetailFixture } from "../detail/agent-session-detail-fixtures";
import {
  createAgentSessionListItemFixture,
  SESSION_FIXTURE_NOW_MS,
} from "./session-list-fixtures";
import { createSessionsListSurfaceV2PreviewUsage } from "./sessions-list-surface-v2-demo";

/** The org tag vocabulary the prototype's Tags picker offers. */
export const SESSIONS_PROTOTYPE_TAGS = [
  { color: TagColor.Blue, id: "prototype-tag-adapter", name: "adapter" },
  { color: TagColor.Green, id: "prototype-tag-parity", name: "parity" },
  { color: TagColor.Amber, id: "prototype-tag-desktop", name: "desktop" },
] as const;

/** Applied tags cycled across rows: none, one, and two. */
const SESSIONS_PROTOTYPE_TAG_SETS = [
  [],
  [SESSIONS_PROTOTYPE_TAGS[0]],
  [SESSIONS_PROTOTYPE_TAGS[1], SESSIONS_PROTOTYPE_TAGS[2]],
] as const;

/**
 * Per-row measurements, cycled by index so neighbouring rows differ in cost,
 * duration, recency, autonomy, priority and pull requests.
 */
const PROTOTYPE_VARIANTS = [
  {
    activityAgoMin: 4,
    autonomy: 82,
    cost: 4.12,
    durationMin: 12,
    priority: Priority.High,
    prCount: 1,
    startedAgoMin: 16,
  },
  {
    activityAgoMin: 95,
    autonomy: 64,
    cost: 2.18,
    durationMin: 47,
    priority: null,
    prCount: 0,
    startedAgoMin: 142,
  },
  {
    activityAgoMin: 30,
    autonomy: null,
    cost: 0.37,
    durationMin: 3,
    priority: Priority.Medium,
    prCount: 0,
    startedAgoMin: 33,
  },
  {
    activityAgoMin: 2,
    autonomy: 91,
    cost: 11.64,
    durationMin: 128,
    priority: Priority.Urgent,
    prCount: 2,
    startedAgoMin: 130,
  },
  {
    activityAgoMin: 1440,
    autonomy: 47,
    cost: 7.05,
    durationMin: 26,
    priority: Priority.Low,
    prCount: 1,
    startedAgoMin: 1466,
  },
  {
    activityAgoMin: 15,
    autonomy: 73,
    cost: 0.92,
    durationMin: 8,
    priority: null,
    prCount: 0,
    startedAgoMin: 23,
  },
  {
    activityAgoMin: 600,
    autonomy: null,
    cost: 23.4,
    durationMin: 215,
    priority: Priority.Medium,
    prCount: 1,
    startedAgoMin: 815,
  },
  {
    activityAgoMin: 2880,
    autonomy: 58,
    cost: 1.58,
    durationMin: 64,
    priority: null,
    prCount: 0,
    startedAgoMin: 2944,
  },
] as const;

const PROTOTYPE_NOW = new Date(SESSION_FIXTURE_NOW_MS);
const PROTOTYPE_MINUTE_MS = 60_000;

/**
 * One list item per prototype session, so the list row and the detail page are
 * two projections of the same record rather than two hand-written fixtures.
 */
const SESSIONS_PROTOTYPE_ITEMS = createSessionsPrototypeSeeds().map(
  toSessionsPrototypeItem
);

/** Stable fixture rows used by the production-bound Sessions prototype. */
export const SESSIONS_PROTOTYPE_ROWS = SESSIONS_PROTOTYPE_ITEMS.map(
  toSessionsPrototypeRow
);

/** Seeded favorites, so the favorite column shows both of its states. */
export const SESSIONS_PROTOTYPE_FAVORITE_IDS = SESSIONS_PROTOTYPE_ROWS.filter(
  (_row, index) => index % 4 === 0
).map((row) => row.id);

/** Honest total and summary values for the prototype's paginated list. */
export const SESSIONS_PROTOTYPE_USAGE = createSessionsListSurfaceV2PreviewUsage(
  { totalSessions: 1047 }
);

export const SESSIONS_PROTOTYPE_TOTAL_ROWS = 1047;

/** Synthetic issue references by session; fixture data never enters the shared surface. */
export const SESSIONS_PROTOTYPE_ISSUES = new Map([
  [
    "session-list-adapter",
    [
      {
        href: "https://example.com/issues/ISS-9527",
        id: "ISS-9527",
        label: "ISS-9527",
        tooltip: "ISS-9527: Sessions list adapter registry",
      },
    ],
  ],
]);

/** Synthetic project labels by session; fixture data never enters the shared surface. */
export const SESSIONS_PROTOTYPE_PROJECTS = new Map([
  ["session-list-adapter", [{ id: "sessions-v2", label: "Sessions v2" }]],
  ["desktop-implementation", [{ id: "desktop", label: "Desktop" }]],
]);

/** Canonical detail fixtures selected by the prototype's memory route. */
export const SESSIONS_PROTOTYPE_DETAILS = new Map(
  SESSIONS_PROTOTYPE_ITEMS.map((item, index) => [
    item.id,
    createSessionsPrototypeDetail(item, index),
  ])
);

/** In-memory comment routes keep the canonical detail interaction fully local. */
export function createSessionsPrototypeApiRoutes(): FixtureRoute[] {
  let comments: TraceComment[] = [];
  let sequence = 0;
  return [
    { method: "GET", path: "/tags", respond: () => SESSIONS_PROTOTYPE_TAGS },
    {
      method: "GET",
      path: "/agent-sessions/*",
      respond: (context) => {
        const sessionId = prototypeSessionIdFromPath(context.pathname);
        return comments.filter((comment) => comment.artifactId === sessionId);
      },
    },
    {
      method: "POST",
      path: "/agent-sessions/*",
      respond: (context) => {
        sequence += 1;
        if (context.pathname.endsWith("/replies")) {
          const updated = addPrototypeReply(comments, context, sequence);
          comments = updated.comments;
          return updated.comment;
        }
        const comment = createPrototypeComment(context, sequence);
        comments = [...comments, comment];
        return comment;
      },
    },
    {
      method: "PATCH",
      path: "/agent-sessions/*",
      respond: (context) => {
        const updated = updatePrototypeComment(comments, context);
        comments = updated.comments;
        return updated.comment;
      },
    },
    {
      method: "DELETE",
      path: "/agent-sessions/*",
      respond: (context) => {
        const commentId = prototypeCommentIdFromPath(context.pathname);
        comments = comments.filter((comment) => comment.id !== commentId);
        return { deleted: true };
      },
    },
  ];
}

function createSessionsPrototypeDetail(
  item: AgentSessionListItem,
  index: number
) {
  const detail = createAgentSessionDetailFixture({
    ...item,
    events: [],
    externalSessionId: `prototype-${item.id}`,
    slug: `SES-${index + 1}`,
  });
  return {
    ...detail,
    turnItems: (detail.turnItems ?? []).filter((turn) => turn.type !== "event"),
  };
}

function createPrototypeComment(
  context: FixtureRequestContext,
  sequence: number
): TraceComment {
  const draft = traceCommentDraftSchema.parse(context.body);
  const sessionId = prototypeSessionIdFromPath(context.pathname);
  const id = `prototype-comment-${sequence}`;
  const createdAt = new Date(Date.UTC(2026, 9, 21, 12, sequence)).toISOString();
  return {
    ...draft,
    anchor: draft.anchor,
    artifactId: sessionId,
    authorAvatarUrl: null,
    authorId: "prototype-user-1",
    authorName: "Ada Lovelace",
    body: draft.body,
    canDelete: true,
    canEdit: true,
    createdAt,
    editedAt: null,
    id,
    kind: draft.kind ?? TraceCommentKind.Comment,
    mentions: draft.mentions ?? [],
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.SessionDetail,
    target: { id: sessionId, type: CommentTargetType.Session },
    threadId: `prototype-thread-${sequence}`,
    updatedAt: createdAt,
  };
}

function addPrototypeReply(
  comments: TraceComment[],
  context: FixtureRequestContext,
  sequence: number
): { comment: TraceComment; comments: TraceComment[] } {
  const draft = traceCommentReplyDraftSchema.parse(context.body);
  const commentId = prototypeCommentIdFromPath(context.pathname, "replies");
  const createdAt = new Date(Date.UTC(2026, 9, 21, 13, sequence)).toISOString();
  let updatedComment: TraceComment | undefined;
  const updatedComments = comments.map((comment) => {
    if (comment.id !== commentId) {
      return comment;
    }
    const reply: TraceCommentReply = {
      authorAvatarUrl: null,
      authorId: "prototype-user-1",
      authorName: "Ada Lovelace",
      body: draft.body,
      canDelete: true,
      canEdit: true,
      createdAt,
      editedAt: null,
      id: `prototype-reply-${sequence}`,
      mentions: draft.mentions ?? [],
      threadId: comment.threadId,
      updatedAt: createdAt,
    };
    updatedComment = {
      ...comment,
      replies: [...(comment.replies ?? []), reply],
      updatedAt: createdAt,
    };
    return updatedComment;
  });
  if (!updatedComment) {
    throw new Error("Prototype comment not found.");
  }
  return { comment: updatedComment, comments: updatedComments };
}

function updatePrototypeComment(
  comments: TraceComment[],
  context: FixtureRequestContext
): { comment: TraceComment; comments: TraceComment[] } {
  const update = traceCommentUpdateSchema.parse(context.body);
  const commentId = prototypeCommentIdFromPath(context.pathname);
  let updatedComment: TraceComment | undefined;
  const updatedComments = comments.map((comment) => {
    if (comment.id !== commentId) {
      return comment;
    }
    updatedComment = {
      ...comment,
      body: update.body,
      editedAt: comment.updatedAt,
      mentions: update.mentions ?? [],
    };
    return updatedComment;
  });
  if (!updatedComment) {
    throw new Error("Prototype comment not found.");
  }
  return { comment: updatedComment, comments: updatedComments };
}

function prototypeSessionIdFromPath(pathname: string): string {
  return decodeURIComponent(pathname.split("/")[2] ?? "");
}

function prototypeCommentIdFromPath(
  pathname: string,
  trailingSegment?: string
): string {
  const segments = pathname.split("/");
  const index = trailingSegment
    ? segments.lastIndexOf(trailingSegment) - 1
    : segments.length - 1;
  return decodeURIComponent(segments[index] ?? "");
}

function createSessionsPrototypeSeeds(): readonly SessionsPrototypeSeed[] {
  const firstRow: SessionsPrototypeSeed = {
    branch: "prd-728-sessions-list-adapter",
    id: "session-list-adapter",
    model: "gpt-5.5",
    name: "Shared sessions list extraction",
    repo: "closedloop-ai/closedloop-ai",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "prototype-user-1", name: "Ada Lovelace" },
  };
  const additionalRows: readonly SessionsPrototypeSeed[] = [
    {
      branch: "desktop-session-detail",
      id: "desktop-implementation",
      model: "claude-opus-4.1",
      name: "Desktop implementation session",
      repo: "closedloop-ai/desktop",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-2", name: "Grace Hopper" },
    },
    {
      branch: "iss-9610-live-updates",
      id: "live-update-announcement",
      model: "claude-sonnet-4.5",
      name: "Announce material list updates",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ERROR,
      user: { id: "prototype-user-3", name: "Katherine Johnson" },
    },
    {
      branch: "main",
      id: "release-readiness",
      model: "gpt-5.5",
      name: "Release readiness verification",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-4", name: "Margaret Hamilton" },
    },
    {
      branch: "session-permission-contract",
      id: "permission-reconciliation",
      model: "claude-opus-4.1",
      name: "Reconcile row and bulk permissions",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-5", name: "Annie Easley" },
    },
    {
      branch: null,
      id: "unresolved-repository",
      model: null,
      name: "Investigate missing repository attribution",
      repo: null,
      status: SESSION_STATUS.ERROR,
      user: null,
    },
    {
      branch: "feature/scroll-restoration-after-session-data-revision",
      id: "scroll-restoration",
      model: "gpt-5.5",
      name: "Keep the visible session anchored through a background refresh",
      repo: "closedloop-ai/desktop",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-2", name: "Grace Hopper" },
    },
    {
      branch: "storybook-narrow-coverage",
      id: "storybook-interactions",
      model: "claude-sonnet-4.5",
      name: "Sessions narrow Storybook interactions",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-6", name: "Mary Jackson" },
    },
    {
      branch: "adapter-registry",
      id: "typed-column-registry",
      model: "gpt-5.5",
      name: "Typed row and field adapter registry",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-1", name: "Ada Lovelace" },
    },
    {
      branch: "prototype-cleanup",
      id: "prototype-orphan-sweep",
      model: "claude-opus-4.1",
      name: "Remove orphaned prototype modules",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-7", name: "Dorothy Vaughan" },
    },
    {
      branch: "api-contract-audit",
      id: "api-contract-audit",
      model: "gpt-5.5",
      name: "Audit the list response contract",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ERROR,
      user: { id: "prototype-user-8", name: "Jean Bartik" },
    },
    {
      branch: "sessions-filter-parity",
      id: "filter-parity",
      model: "claude-sonnet-4.5",
      name: "Match web and Desktop filters",
      repo: "closedloop-ai/desktop",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-3", name: "Katherine Johnson" },
    },
    {
      branch: "focus-anchor",
      id: "focus-anchor",
      model: "gpt-5.5",
      name: "Restore focus after list reconciliation",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-9", name: "Frances Allen" },
    },
    {
      branch: "session-detail-cards",
      id: "detail-compact-cards",
      model: "claude-opus-4.1",
      name: "Compact cards for the detail session table",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-4", name: "Margaret Hamilton" },
    },
    {
      branch: "desktop-ipc-contract",
      id: "desktop-ipc-contract",
      model: "gpt-5.5",
      name: "Desktop Sessions IPC contract",
      repo: "closedloop-ai/desktop",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-10", name: "Evelyn Boyd Granville" },
    },
    {
      branch: "session-row-actions",
      id: "row-actions",
      model: "claude-sonnet-4.5",
      name: "Session row action menu parity",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-5", name: "Annie Easley" },
    },
    {
      branch: "bulk-favorite-receipts",
      id: "bulk-favorites",
      model: "gpt-5.5",
      name: "Bulk favorite receipts",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ERROR,
      user: { id: "prototype-user-6", name: "Mary Jackson" },
    },
    {
      branch: "session-column-resize",
      id: "column-resize",
      model: "claude-opus-4.1",
      name: "Persist Sessions column widths",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-7", name: "Dorothy Vaughan" },
    },
    {
      branch: "usage-summary",
      id: "usage-summary",
      model: "gpt-5.5",
      name: "Sessions usage summary reconciliation",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-8", name: "Jean Bartik" },
    },
    {
      branch: null,
      id: "local-experiment",
      model: "claude-sonnet-4.5",
      name: "Local experiment without a branch",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-9", name: "Frances Allen" },
    },
    {
      branch: "session-inline-edit",
      id: "inline-edit",
      model: "gpt-5.5",
      name: "Preserve an in-progress session rename",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-10", name: "Evelyn Boyd Granville" },
    },
    {
      branch: "pagination-counts",
      id: "pagination-counts",
      model: "claude-opus-4.1",
      name: "Reconcile pagination counts across hosts",
      repo: "closedloop-ai/desktop",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-1", name: "Ada Lovelace" },
    },
    {
      branch: "accessibility-pass",
      id: "accessibility-pass",
      model: "gpt-5.5",
      name: "Sessions list accessibility pass",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ERROR,
      user: { id: "prototype-user-3", name: "Katherine Johnson" },
    },
    {
      branch: "legacy-table-retirement",
      id: "legacy-retirement",
      model: "claude-sonnet-4.5",
      name: "Retire the legacy Sessions table seam",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.INACTIVE,
      user: { id: "prototype-user-4", name: "Margaret Hamilton" },
    },
    {
      branch: "surface-parity-proof",
      id: "surface-parity-proof",
      model: "gpt-5.5",
      name: "Sessions surface cross-host parity proof",
      repo: "closedloop-ai/closedloop-ai",
      status: SESSION_STATUS.ACTIVE,
      user: { id: "prototype-user-5", name: "Annie Easley" },
    },
  ];

  return [firstRow, ...additionalRows];
}

type SessionsPrototypeSeed = {
  branch: string | null;
  id: string;
  model: string | null;
  name: string;
  repo: string | null;
  status: SessionStatus;
  user: { id: string; name: string } | null;
};

function toSessionsPrototypeItem(
  seed: SessionsPrototypeSeed,
  index: number
): AgentSessionListItem {
  const variant = PROTOTYPE_VARIANTS[index % PROTOTYPE_VARIANTS.length];
  const minutesAgo = (minutes: number) =>
    new Date(SESSION_FIXTURE_NOW_MS - minutes * PROTOTYPE_MINUTE_MS);
  const isActive = seed.status === SESSION_STATUS.ACTIVE;
  const lastActivityAt = minutesAgo(isActive ? 1 : variant.activityAgoMin);
  const prs = Array.from({ length: variant.prCount }, (_unused, prIndex) => ({
    num: 9000 + index * 3 + prIndex,
    status:
      prIndex === 0 && !isActive
        ? SessionPrLifecycleStatus.Merged
        : SessionPrLifecycleStatus.Open,
    title: seed.name,
  }));
  return createAgentSessionListItemFixture({
    autonomy: variant.autonomy,
    branch: seed.branch,
    endedAt: isActive ? null : lastActivityAt,
    estimatedCost: variant.cost,
    externalSessionId: `prototype-${seed.id}`,
    harness: seed.model?.startsWith("gpt") ? Harness.Codex : Harness.Claude,
    id: seed.id,
    lastActivityAt,
    model: seed.model,
    name: seed.name,
    priority: variant.priority,
    prs,
    prsMerged: prs.filter((pr) => pr.status === SessionPrLifecycleStatus.Merged)
      .length,
    recordUpdatedAt: lastActivityAt,
    repositoryFullName: seed.repo,
    startedAt: minutesAgo(variant.startedAgoMin),
    status: seed.status,
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
    tags: SESSIONS_PROTOTYPE_TAG_SETS[
      index % SESSIONS_PROTOTYPE_TAG_SETS.length
    ],
    updatedAt: lastActivityAt,
    user: seed.user ? toPrototypeUser(seed.user) : null,
  });
}

function toSessionsPrototypeRow(item: AgentSessionListItem): SessionTableRow {
  const row = agentSessionToSessionTableRow(item, item.repositoryFullName, {
    now: PROTOTYPE_NOW,
  });
  // The mapper's recency labels read the ambient clock; a fixture pins them to
  // the same instant its timestamps were built from.
  const label = (instant: Date | null | undefined) =>
    instant ? formatRelativeTime(instant, { now: PROTOTYPE_NOW }) : null;
  return {
    ...row,
    lastActivityLabel: label(toSessionInstant(item.lastActivityAt)),
    startedLabel: label(toSessionInstant(item.startedAt)) ?? row.startedLabel,
    updatedLabel: label(toSessionInstant(item.recordUpdatedAt)),
  };
}

function toPrototypeUser(user: { id: string; name: string }) {
  const [firstName = user.name, ...rest] = user.name.split(" ");
  return {
    avatarUrl: null,
    email: `${user.id}@example.com`,
    firstName,
    id: user.id,
    lastName: rest.join(" "),
  };
}

/**
 * A prototype detail for a session another sandbox route already lists, built
 * through the same list-item fixture and detail projection as the rows above.
 */
export function createSessionsPrototypeDetailFromItem(
  overrides: Partial<AgentSessionListItem> & { id: string },
  index: number
) {
  return createSessionsPrototypeDetail(
    createAgentSessionListItemFixture(overrides),
    index
  );
}
