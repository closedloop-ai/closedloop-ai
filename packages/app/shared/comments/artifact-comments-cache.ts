import type { CommentSurface } from "@repo/api/src/types/comment";
import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { POLL_BACKOFF } from "@repo/realtime-client/poll";
import type { CommentsDataSource } from "./comments-data-source";

/** Which comments one query holds: a target id (artifact or session) on one surface. */
export type ArtifactCommentsTarget = {
  id: string;
  /** Omitted: every thread on the artifact, a Branch's GitHub threads included. */
  surface?: CommentSurface;
};

/** The whole collection, every page read. */
export type ArtifactCommentsCollection = {
  /** The resolved artifact, which names the realtime channel; null when unknown. */
  artifactId: string | null;
  capabilities: CollectionCapabilities;
  threads: CommentThreadDto[];
};

export const artifactCommentKeys = {
  all: ["artifact-comments"] as const,
  target: (target: ArtifactCommentsTarget) =>
    [
      ...artifactCommentKeys.all,
      target.id,
      target.surface ?? "all-surfaces",
    ] as const,
};

/**
 * How long a local create or delete is protected from a reload that was
 * already in flight: three poll intervals, as the trace-comment lane sizes it.
 */
export const COMMENT_RACE_MARKER_TTL_MS = POLL_BACKOFF.minMs * 3;

/** A server that hands the same cursor back would page forever. */
export class CommentsCursorLoopError extends Error {
  constructor() {
    super("The comments list repeated a page cursor.");
    this.name = "CommentsCursorLoopError";
  }
}

/** Follows `nextCursor` to the end: no page cap, so nothing is silently dropped. */
export async function readArtifactCommentsCollection(
  dataSource: CommentsDataSource,
  target: ArtifactCommentsTarget,
  signal?: AbortSignal
): Promise<ArtifactCommentsCollection> {
  const readPage = (cursor?: string) =>
    dataSource.list(target.id, {
      ...(target.surface ? { surface: target.surface } : {}),
      ...(cursor ? { cursor } : {}),
      ...(signal ? { signal } : {}),
    });
  const first = await readPage();
  const threads = [...first.threads];
  const seen = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new CommentsCursorLoopError();
    }
    seen.add(cursor);
    const page = await readPage(cursor);
    threads.push(...page.threads);
    cursor = page.nextCursor;
  }
  return {
    // A server that predates `artifactId` still names it on any thread.
    artifactId: first.artifactId ?? threads[0]?.artifactId ?? null,
    capabilities: first.capabilities,
    threads,
  };
}

export function threadBelongsToTarget(
  thread: CommentThreadDto,
  target: ArtifactCommentsTarget
): boolean {
  return target.surface === undefined || thread.surface === target.surface;
}

/**
 * Puts one thread into the list. A version at a lower revision than the one
 * held is dropped, so a slow response never undoes a newer one; a tie takes
 * the incoming copy, so a server echo is idempotent.
 */
export function upsertThread(
  threads: readonly CommentThreadDto[],
  incoming: CommentThreadDto
): CommentThreadDto[] {
  const held = threads.find((thread) => thread.id === incoming.id);
  if (held && held.revision > incoming.revision) {
    return [...threads];
  }
  return sortThreads([
    ...threads.filter((thread) => thread.id !== incoming.id),
    incoming,
  ]);
}

export function removeThread(
  threads: readonly CommentThreadDto[],
  threadId: string
): CommentThreadDto[] {
  return threads.filter((thread) => thread.id !== threadId);
}

/** Thread ids a local write created or removed, each with when it was marked. */
export type CommentRaceMarkers = {
  created: Map<string, number>;
  removed: Map<string, number>;
};

export function createCommentRaceMarkers(): CommentRaceMarkers {
  return { created: new Map(), removed: new Map() };
}

export function markThread(
  markers: Map<string, number>,
  threadId: string,
  now: number
): void {
  markers.set(threadId, now);
}

/**
 * Reconciles a reloaded collection with what the cache holds. Per thread the
 * higher revision wins; a thread the reload left out survives while its create
 * marker is live (the reload predates the create); a thread removed locally
 * stays out while its marker is live (the reload predates the delete). Expired
 * markers are cleared, and so is a create marker the reload has caught up with;
 * a remove marker lives out its TTL, since a single-thread read that predates
 * the removal can still land after the reload.
 */
export function mergeReloadedThreads(
  held: readonly CommentThreadDto[],
  reloaded: readonly CommentThreadDto[],
  markers: CommentRaceMarkers,
  now: number
): CommentThreadDto[] {
  const reloadedIds = new Set(reloaded.map((thread) => thread.id));
  expireMarkers(markers.created, now, (id) => reloadedIds.has(id));
  expireMarkers(markers.removed, now, () => false);
  const heldById = new Map(held.map((thread) => [thread.id, thread]));
  const merged = reloaded
    .filter((thread) => !markers.removed.has(thread.id))
    .map((thread) => {
      const current = heldById.get(thread.id);
      return current && current.revision > thread.revision ? current : thread;
    });
  const kept = held.filter(
    (thread) => !reloadedIds.has(thread.id) && markers.created.has(thread.id)
  );
  return sortThreads([...merged, ...kept]);
}

function expireMarkers(
  markers: Map<string, number>,
  now: number,
  caughtUp: (id: string) => boolean
): void {
  for (const [id, markedAt] of markers) {
    if (markedAt + COMMENT_RACE_MARKER_TTL_MS <= now || caughtUp(id)) {
      markers.delete(id);
    }
  }
}

/** The server's `(createdAt, id)` order, which is total: ids are unique. */
function sortThreads(threads: CommentThreadDto[]): CommentThreadDto[] {
  return threads.sort((a, b) => {
    const left = createdAtKey(a);
    const right = createdAtKey(b);
    if (left !== right) {
      return left < right ? -1 : 1;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });
}

/** An unparseable timestamp sorts last, by id, so the order stays total. */
function createdAtKey(thread: CommentThreadDto): number {
  const time = Date.parse(thread.createdAt);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * Whether a local removal of the thread landed at or after `since`, so a
 * response to a request that began then predates it.
 * lc-debt: holds only until a reload clears the remove marker past its TTL; a
 * read slower than that can still restore a removed thread. Track in-flight
 * reads per thread to close it.
 */
export function removedSince(
  markers: CommentRaceMarkers,
  threadId: string,
  since: number
): boolean {
  const removedAt = markers.removed.get(threadId);
  return removedAt !== undefined && removedAt >= since;
}
