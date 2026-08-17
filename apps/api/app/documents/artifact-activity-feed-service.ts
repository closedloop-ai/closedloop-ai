import { ArtifactActivityActorType } from "@repo/api/src/types/artifact-activity";
import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT,
  ARTIFACT_ACTIVITY_FEED_MAX_LIMIT,
  type ArtifactActivityFeedItem,
  type ArtifactActivityFeedResult,
} from "@repo/api/src/types/artifact-activity-feed";
import { LinkType, withDb } from "@repo/database";
import { fromJsonColumn } from "./artifact-activity-service";

/**
 * Artifact activity FEED service (FEA-3864 / FEA-3535 Slice 3).
 *
 * Reads the aggregate, on-read activity timeline for a single artifact for
 * `GET /documents/[id]/activity`. Merges the persisted `ArtifactActivityEvent`
 * store rows with on-read PROJECTIONS of history that already lives in other
 * tables — document versions, PRODUCES derivation links (both directions),
 * loops referencing the artifact, and evaluations — into one normalized,
 * newest-first, cursor-paginated stream.
 *
 * Every source query is org-scoped (`organizationId` in the WHERE) so the feed
 * never leaks another org's rows. Comments are deliberately NOT projected — the
 * live Liveblocks comment source already delivers them; re-projecting would
 * double-count (CLAUDE.md aggregation rule).
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
 * deterministically.
 */
type DecodedCursor = { createdAtMs: number; id: string };

function encodeCursor(item: ArtifactActivityFeedItem): string {
  return Buffer.from(`${item.createdAt.getTime()}:${item.id}`, "utf8").toString(
    "base64url"
  );
}

function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) {
    return null;
  }
  const createdAtMs = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!(Number.isFinite(createdAtMs) && id)) {
    return null;
  }
  return { createdAtMs, id };
}

/**
 * Normalize a store `actorType` to the feed's actor kind. `agent` → agent,
 * `system` → system, everything else (`user`) → human.
 */
function actorKindFromStore(actorType: string): ActivityFeedActor["kind"] {
  if (actorType === ArtifactActivityActorType.Agent) {
    return ActivityFeedActorKind.Agent;
  }
  if (actorType === ArtifactActivityActorType.System) {
    return ActivityFeedActorKind.System;
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
  Loop: "loop",
  Evaluation: "evaluation",
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

/** Project the persisted store rows. */
async function projectEvents(
  ctx: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: {
        organizationId: ctx.organizationId,
        artifactId: ctx.artifactId,
        AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Event)],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ctx.take,
    })
  );
  return rows.map((row) => ({
    id: `${FeedIdPrefix.Event}:${row.id}`,
    source: ActivityFeedItemSource.Event,
    action: row.action,
    actor: { kind: actorKindFromStore(row.actorType), id: row.actorId },
    before: fromJsonColumn(row.before),
    after: fromJsonColumn(row.after),
    payload: null,
    createdAt: row.createdAt,
  }));
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

/** Project `loops` referencing this artifact as `loop` items. */
async function projectLoops(
  ctx: FeedQueryContext
): Promise<ArtifactActivityFeedItem[]> {
  const rows = await withDb((db) =>
    db.loop.findMany({
      where: {
        organizationId: ctx.organizationId,
        artifactId: ctx.artifactId,
        AND: [keysetCreatedAtFragment(ctx.cursor, FeedIdPrefix.Loop)],
      },
      select: {
        id: true,
        userId: true,
        status: true,
        command: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ctx.take,
    })
  );
  return rows.map((row) => ({
    id: `${FeedIdPrefix.Loop}:${row.id}`,
    source: ActivityFeedItemSource.Loop,
    action: null,
    // A loop is an agent run; attribute to the run's owner as an agent actor.
    actor: { kind: ActivityFeedActorKind.Agent, id: row.userId },
    before: null,
    after: null,
    payload: { loopId: row.id, status: row.status, command: row.command },
    createdAt: row.createdAt,
  }));
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
        loopId: true,
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
    payload: { reportType: row.reportType, loopId: row.loopId },
    createdAt: row.createdAt,
  }));
}

export type ListActivityFeedInput = {
  organizationId: string;
  artifactId: string;
  cursor?: string | null;
  limit?: number;
};

/**
 * Merge the store rows + on-read projections into one newest-first,
 * cursor-paginated page for a single artifact. Org-scoped on every source.
 */
async function listActivityFeed(
  input: ListActivityFeedInput
): Promise<ArtifactActivityFeedResult> {
  if (!(input.organizationId && input.artifactId)) {
    throw new Error("organizationId and artifactId are required");
  }

  const limit = Math.min(
    Math.max(1, input.limit ?? ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT),
    ARTIFACT_ACTIVITY_FEED_MAX_LIMIT
  );
  const cursor = decodeCursor(input.cursor);
  const ctx: FeedQueryContext = {
    organizationId: input.organizationId,
    artifactId: input.artifactId,
    cursor,
    // Each source only needs enough rows to fill one merged page; +1 lookahead.
    take: limit + 1,
  };

  const [events, versions, derivations, loops, evaluations] = await Promise.all(
    [
      projectEvents(ctx),
      projectVersions(ctx),
      projectDerivations(ctx),
      projectLoops(ctx),
      projectEvaluations(ctx),
    ]
  );

  let merged = [
    ...events,
    ...versions,
    ...derivations,
    ...loops,
    ...evaluations,
  ].sort(compareDesc);

  // Every source's keyset predicate already excludes the cursor row and prior
  // pages, so this in-memory filter is now a defensive no-op — kept so a future
  // regression in a per-source predicate cannot leak an already-returned row.
  if (cursor) {
    merged = merged.filter((item) => isAfterCursor(item, cursor));
  }

  const hasMore = merged.length > limit;
  const items = hasMore ? merged.slice(0, limit) : merged;
  const lastItem = items.at(-1);
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem) : null;

  return { items, nextCursor };
}

export const artifactActivityFeedService = {
  listActivityFeed,
};
