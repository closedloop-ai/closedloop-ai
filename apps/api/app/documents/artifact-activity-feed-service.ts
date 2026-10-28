import {
  ArtifactActivityAction,
  type ArtifactActivityAction as ArtifactActivityActionValue,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT,
  ARTIFACT_ACTIVITY_FEED_MAX_LIMIT,
  type ArtifactActivityFeedItem,
  type ArtifactActivityFeedResult,
} from "@repo/api/src/types/artifact-activity-feed";
import type { CommentSurface } from "@repo/api/src/types/comment";
import { LinkType, withDb } from "@repo/database";
import { parseTraceCommentMetadata } from "@/app/comments/service/trace-comment-metadata";
import { isUuid } from "@/lib/is-uuid";
import { decodeTimeIdCursor, encodeTimeIdCursor } from "@/lib/time-id-cursor";
import { fromJsonColumn } from "./artifact-activity-service";
import { commentThreadActivityActor } from "./comment-thread-activity-actor";

/**
 * Artifact activity FEED service (FEA-3864 / FEA-3535 Slice 3).
 *
 * Reads one artifact's activity with shared cursor mechanics. The Document
 * route merges persisted `ArtifactActivityEvent` rows with versions, PRODUCES
 * links and evaluations. Session and Branch routes read stored V1 edits
 * only. Both paths return the same newest-first, cursor-paginated page.
 *
 * Every source query is org-scoped (`organizationId` in the WHERE) so the feed
 * never leaks another org's rows.
 *
 * Comments are projected for the Session and Branch read (ISS-11004, operator
 * 2026-10-07) and NOT for the Document read, because the Document feed rail
 * mounts this feed's activity source AND the live Liveblocks comment source
 * side by side: projecting there would list every document comment twice, once
 * as a live card carrying its body and reply composer and once as a read-only
 * pointer. The operator's ruling was to leave how comments work alone and add
 * only the link to them, so the duplication is avoided by scope rather than by
 * taking the live source away.
 *
 * Pagination: the merged stream spans multiple tables and cannot page on a
 * single table's row id, so we use a `(createdAt, id)` keyset encoded into an
 * opaque cursor. Each source applies the FULL `(createdAt, id)` keyset
 * predicate in its query (`keysetCreatedAtFragment`) — not a coarse
 * `createdAt <= cursorTime` bound — so rows tied at the cursor's timestamp are
 * never dropped when more than `limit + 1` share that millisecond. Each source
 * fetches `take = limit + 1` already-after-cursor rows; the merged, sorted
 * result is sliced to `limit`, with the lookahead determining `nextCursor`.
 */

/**
 * Opaque cursor: base64url of `${createdAtMs}:${id}`. The last item's timestamp
 * + source-qualified id, so a shared `createdAt` across sources still paginates
 * deterministically. The codec itself is `@/lib/time-id-cursor`, shared with
 * the other keyset reads that page on a timestamp plus a tiebreaking id.
 */
type DecodedCursor = { createdAtMs: number; id: string };

function encodeCursor(item: ArtifactActivityFeedItem): string {
  return encodeTimeIdCursor(item.createdAt.getTime(), item.id);
}

function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  const decoded = decodeTimeIdCursor(cursor);
  if (!decoded) {
    return null;
  }
  return { createdAtMs: decoded.ms, id: decoded.id };
}

/**
 * Normalize a stored actor; an unknown V1 type has no truthful client kind.
 */
function actorKindFromStore(
  actorType: string,
  excludeUnknownActorType = false
): ActivityFeedActor["kind"] | null {
  if (actorType === ArtifactActivityActorType.Agent) {
    return ActivityFeedActorKind.Agent;
  }
  if (actorType === ArtifactActivityActorType.System) {
    return ActivityFeedActorKind.System;
  }
  if (actorType === ArtifactActivityActorType.User) {
    return ActivityFeedActorKind.Human;
  }
  if (excludeUnknownActorType) {
    return null;
  }
  return ActivityFeedActorKind.Human;
}

/**
 * Descending comparator on `(createdAt desc, id desc)` — newest first, id as a
 * stable tiebreak so a shared timestamp orders deterministically.
 */
function compareDesc(
  a: ArtifactActivityFeedItem,
  b: ArtifactActivityFeedItem
): number {
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) {
    return bt - at;
  }
  if (a.id < b.id) {
    return 1;
  }
  if (a.id > b.id) {
    return -1;
  }
  return 0;
}

/**
 * True when `item` sorts strictly AFTER the cursor position under `compareDesc`
 * — i.e. it belongs on a later page. Used to drop the cursor row itself and
 * anything already returned on prior pages.
 */
function isAfterCursor(
  item: ArtifactActivityFeedItem,
  cursor: DecodedCursor
): boolean {
  const t = item.createdAt.getTime();
  if (t !== cursor.createdAtMs) {
    return t < cursor.createdAtMs;
  }
  return item.id < cursor.id;
}

/**
 * The qualified-id prefix for each feed source. This is the SINGLE source of
 * truth for the `${prefix}:${rawId}` id shape: every projector builds its item
 * id from it, and the keyset predicate derives its boundary comparison from it,
 * so the two can never drift. Note these are NOT the `ActivityFeedItemSource`
 * values (e.g. the version source is `version_created` but its id prefix is
 * `version`); the id prefix is its own contract.
 */
const FeedIdPrefix = {
  Event: "event",
  Version: "version",
  Derivation: "derivation",
  Evaluation: "evaluation",
  Comment: "comment",
} as const;
type FeedIdPrefix = (typeof FeedIdPrefix)[keyof typeof FeedIdPrefix];

type FeedQueryContext = {
  organizationId: string;
  artifactId: string;
  /** The decoded page cursor, or null on the first page. */
  cursor: DecodedCursor | null;
  /** Per-source fetch size (limit + 1 lookahead). */
  take: number;
};

/**
 * A Prisma `where` fragment (over `createdAt` / `id`) meant to be combined with
 * a source's own predicates under `AND`. Returning an `AND`-composable fragment
 * (rather than a bare `OR`) avoids colliding with a source query that already
 * uses `OR` (e.g. the derivation source's source/target direction).
 */
type KeysetFragment = Record<string, unknown>;

/**
 * The `(createdAt, id)` keyset predicate for one source, so pagination never
 * loses rows tied at the cursor's timestamp.
 *
 * The merged feed sorts by `(createdAt desc, qualifiedId desc)` where the
 * qualified id is `${prefix}:${rawId}`. A row belongs on a later page iff it
 * sorts strictly after the cursor: `createdAt < cursorMs`, OR
 * `createdAt == cursorMs AND qualifiedId < cursorId` (string compare).
 *
 * At the boundary timestamp the qualified-id comparison resolves per source:
 * - Cursor id has THIS source's prefix → reduces to `rawId < cursorRaw` on the
 *   DB `id` column (a real per-source keyset tiebreak).
 * - Cursor id has a DIFFERENT prefix → the two prefixes decide it, so every
 *   boundary row of this source is uniformly after the cursor (contribute all
 *   boundary rows) or before it (contribute none).
 *
 * Because the predicate is applied in the query, every fetched row already sorts
 * after the cursor — the caller no longer over-fetches at the cursor timestamp
 * and then filters those rows out in memory, which is what dropped tied rows
 * beyond `limit + 1` and truncated the feed.
 */
function keysetCreatedAtFragment(
  cursor: DecodedCursor | null,
  prefix: FeedIdPrefix
): KeysetFragment {
  if (!cursor) {
    return {};
  }
  const boundary = new Date(cursor.createdAtMs);
  const strictlyBefore = { createdAt: { lt: boundary } };

  const cursorPrefixSep = cursor.id.indexOf(":");
  const cursorPrefix =
    cursorPrefixSep === -1 ? cursor.id : cursor.id.slice(0, cursorPrefixSep);

  if (cursorPrefix === prefix) {
    // Same source as the cursor: tiebreak on the raw DB id at the boundary ms.
    const cursorRaw = cursor.id.slice(cursorPrefixSep + 1);
    return {
      OR: [strictlyBefore, { createdAt: boundary, id: { lt: cursorRaw } }],
    };
  }

  // Different source: boundary rows sort uniformly relative to the cursor by
  // prefix. `${prefix}:...` < `${cursorPrefix}:...` iff `prefix < cursorPrefix`.
  if (prefix < cursorPrefix) {
    return { OR: [strictlyBefore, { createdAt: boundary }] };
  }
  return strictlyBefore;
}

/**
 * Project `comment_threads` as `comment` items (ISS-11004). One item per
 * thread, attributed to its author ({@link commentThreadActivityActor}); a
 * thread with no attributable author is still projected, because the comment
 * happened either way.
 *
 * The payload carries the thread's trace-comment SURFACE where it has one
 * (ISS-10980, operator 2026-10-08: a Branch comment row sends the reader to
 * the Artifact canvas or the Sessions tab, whichever holds the comment). It is
 * read from `metadata`, which is where a trace thread records it; a thread
 * with no parseable trace metadata omits the key rather than guessing one.
 */
async function projectCommentThreads(
  ctx: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb((db) =>
    db.commentThread.findMany({
      where: {
        organizationId: ctx.organizationId,
        artifactId: ctx.artifactId,
        // A root delete soft-deletes every comment row and leaves the thread
        // row, so a thread with no live comment is gone for the rail too.
        comments: { some: { deletedAt: null } },
        AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Comment)],
      },
      select: {
        id: true,
        createdById: true,
        source: true,
        status: true,
        metadata: true,
        createdAt: true,
        comments: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 1,
          select: {
            authorId: true,
            githubProjection: {
              select: {
                externalAuthor: {
                  where: { organizationId: ctx.organizationId },
                  select: { providerDetail: true },
                },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ctx.take,
    })
  );
  return rows.map((row) => ({
    id: `${FeedIdPrefix.Comment}:${row.id}`,
    source: ActivityFeedItemSource.Comment,
    action: null,
    actor: commentThreadActivityActor(row),
    before: null,
    after: null,
    // `threadId` is what a client needs to deep-link the comment; `status` and
    // `source` say whether it is resolved and where it came from; `surface`
    // says which of a host's tabs holds it. `surface` is OMITTED, never null,
    // when the thread records none — an absent optional field on a
    // version-skewed wire (root `AGENTS.md` -> Cross-Repo Compatibility).
    payload: {
      threadId: row.id,
      status: row.status,
      source: row.source,
      ...commentThreadSurfacePayload(row.metadata),
    },
    createdAt: row.createdAt,
  }));
}

/** Project the persisted store rows. */
async function projectEvents(
  ctx: FeedQueryContext,
  actions?: readonly ArtifactActivityActionValue[],
  excludeUnknownActorType = false
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb(async (db) => {
    // Each edit action can use the action-leading cursor index even with a
    // generic query plan. The Document path retains its single unfiltered read.
    const pages = await Promise.all(
      (actions ?? [undefined]).map((action) =>
        db.artifactActivityEvent.findMany({
          where: {
            organizationId: ctx.organizationId,
            artifactId: ctx.artifactId,
            ...(action ? { action } : {}),
            ...(excludeUnknownActorType
              ? { actorType: { in: Object.values(ArtifactActivityActorType) } }
              : {}),
            AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Event)],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: ctx.take,
          // The projected item never restates its known org or artifact scope.
          select: {
            id: true,
            action: true,
            actorType: true,
            actorId: true,
            before: true,
            after: true,
            createdAt: true,
          },
        })
      )
    );
    return pages.flat();
  });
  return rows.flatMap((row) => {
    const kind = actorKindFromStore(row.actorType, excludeUnknownActorType);
    if (!kind) {
      return [];
    }
    return [
      {
        id: `${FeedIdPrefix.Event}:${row.id}`,
        source: ActivityFeedItemSource.Event,
        action: row.action,
        actor: { kind, id: row.actorId },
        before: fromJsonColumn(row.before),
        after: fromJsonColumn(row.after),
        payload: null,
        createdAt: row.createdAt,
      },
    ];
  });
}

/** Project `document_versions` as `version_created` items. */
async function projectVersions(
  ctx: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb((db) =>
    db.documentVersion.findMany({
      where: {
        documentId: ctx.artifactId,
        // Org scope: the parent artifact must belong to the org.
        documentDetail: { artifact: { organizationId: ctx.organizationId } },
        AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Version)],
      },
      select: { id: true, version: true, createdById: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ctx.take,
    })
  );
  return rows.map((row) => ({
    id: `${FeedIdPrefix.Version}:${row.id}`,
    source: ActivityFeedItemSource.VersionCreated,
    action: null,
    actor: {
      kind: row.createdById
        ? ActivityFeedActorKind.Human
        : ActivityFeedActorKind.System,
      id: row.createdById,
    },
    before: null,
    after: null,
    payload: { version: row.version },
    createdAt: row.createdAt,
  }));
}

/**
 * Project PRODUCES `artifact_links` (both directions) as `derivation` items.
 * `direction: "produced"` = this artifact produced the linked one (outgoing);
 * `direction: "produced_from"` = this artifact was produced from the linked one
 * (incoming).
 */
async function projectDerivations(
  ctx: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId: ctx.organizationId,
        linkType: LinkType.PRODUCES,
        OR: [{ sourceId: ctx.artifactId }, { targetId: ctx.artifactId }],
        AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Derivation)],
      },
      select: {
        id: true,
        sourceId: true,
        targetId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ctx.take,
    })
  );
  return rows.map((row) => {
    const outgoing = row.sourceId === ctx.artifactId;
    return {
      id: `${FeedIdPrefix.Derivation}:${row.id}`,
      source: ActivityFeedItemSource.Derivation,
      action: null,
      actor: { kind: ActivityFeedActorKind.System, id: null },
      before: null,
      after: null,
      payload: {
        direction: outgoing ? "produced" : "produced_from",
        relatedArtifactId: outgoing ? row.targetId : row.sourceId,
      },
      createdAt: row.createdAt,
    } satisfies ArtifactActivityFeedItem;
  });
}

/** Project `artifact_evaluations` as `evaluation` items. */
async function projectEvaluations(
  ctx: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb((db) =>
    db.artifactEvaluation.findMany({
      where: {
        organizationId: ctx.organizationId,
        artifactId: ctx.artifactId,
        AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Evaluation)],
      },
      select: {
        id: true,
        reportType: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ctx.take,
    })
  );
  return rows.map((row) => ({
    id: `${FeedIdPrefix.Evaluation}:${row.id}`,
    source: ActivityFeedItemSource.Evaluation,
    action: null,
    actor: { kind: ActivityFeedActorKind.System, id: null },
    before: null,
    after: null,
    payload: { reportType: row.reportType },
    createdAt: row.createdAt,
  }));
}

export type ListActivityFeedInput = {
  organizationId: string;
  artifactId: string;
  cursor?: string | null;
  limit?: number;
};

type FeedProjector = (
  context: FeedQueryContext
) => Promise<ArtifactActivityFeedItem[]>;

const V1_EDIT_ACTIONS = [
  ArtifactActivityAction.StatusChange,
  ArtifactActivityAction.FieldChange,
  ArtifactActivityAction.Assignment,
] as const;

/**
 * V1 shows known edits and actors. Filtering future actor kinds in the query
 * keeps pagination complete on older servers without assigning a false person.
 */
function projectV1EditEvents(
  context: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  return projectEvents(context, V1_EDIT_ACTIONS, true);
}

/** Apply the same bounded keyset page mechanics to each artifact's sources. */
async function listFeed(
  input: ListActivityFeedInput,
  projectors: readonly FeedProjector[]
): Promise<ArtifactActivityFeedResult> {
  if (!(input.organizationId && input.artifactId)) {
    throw new Error("organizationId and artifactId are required");
  }

  const limit = Math.min(
    Math.max(1, input.limit ?? ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT),
    ARTIFACT_ACTIVITY_FEED_MAX_LIMIT
  );
  const cursor = decodeCursor(input.cursor);
  const context: FeedQueryContext = {
    organizationId: input.organizationId,
    artifactId: input.artifactId,
    cursor,
    take: limit + 1,
  };

  const sourcePages = await Promise.all(
    projectors.map((projector) => projector(context))
  );
  let merged = sourcePages.flat().sort(compareDesc);

  // The source predicates already exclude prior pages. Keep this guard against
  // a future projector that forgets the complete time-and-id boundary.
  if (cursor) {
    merged = merged.filter((item) => isAfterCursor(item, cursor));
  }

  const hasMore = merged.length > limit;
  const items = hasMore ? merged.slice(0, limit) : merged;
  const lastItem = items.at(-1);
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem) : null;

  return { items, nextCursor };
}

/** Merge Document events and projections without changing their public route. */
function listActivityFeed(
  input: ListActivityFeedInput
): Promise<ArtifactActivityFeedResult> {
  return listFeed(input, [
    projectEvents,
    projectVersions,
    projectDerivations,
    projectEvaluations,
  ]);
}

/** V1 stored edits plus comments, for the Session and Branch Activity hosts. */
function listStoredEventActivityFeed(
  input: ListActivityFeedInput
): Promise<ArtifactActivityFeedResult> {
  return listFeed(input, [projectV1EditEvents, projectCommentThreads]);
}

/**
 * The Session/Branch route accepts only a cursor one of ITS sources could
 * mint. Since ISS-11004 that is the stored event source or the comment source,
 * so a page whose last item is a comment pages on; before comments joined the
 * feed, an `event:`-only check was the whole contract.
 */
export function isValidStoredEventCursor(cursor: string): boolean {
  const prefixes = [`${FeedIdPrefix.Event}:`, `${FeedIdPrefix.Comment}:`];
  const decoded = decodeTimeIdCursor(cursor, (id) => {
    const prefix = prefixes.find((candidate) => id.startsWith(candidate));
    if (!prefix) {
      return false;
    }
    const rowId = id.slice(prefix.length);
    return isUuid(rowId) && rowId === rowId.toLowerCase();
  });
  return (
    decoded !== null && encodeTimeIdCursor(decoded.ms, decoded.id) === cursor
  );
}

export const artifactActivityFeedService = {
  listActivityFeed,
  listStoredEventActivityFeed,
};

/**
 * The `{ surface }` fragment a comment item's payload carries, or `{}` when
 * the thread records no parseable trace-comment surface. A fragment rather
 * than a value so the key is absent on the wire instead of null.
 */
function commentThreadSurfacePayload(
  metadata: unknown
): { surface: CommentSurface } | Record<string, never> {
  const surface = parseTraceCommentMetadata(metadata)?.surface;
  return surface ? { surface } : {};
}
