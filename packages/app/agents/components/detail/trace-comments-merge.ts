import type { TraceComment } from "@repo/api/src/types/comment";
import { parseTimestampMs, sortByCreatedAtThenId } from "./comment-sort";
import { TRACE_COMMENTS_REFETCH_INTERVAL_MS } from "./trace-comments-poll-cadence";

/**
 * Merge algebra for the trace-comments live read.
 *
 * A poll and a local mutation race constantly: a request already in flight when
 * the reader creates or deletes a comment returns a list that predates the write.
 * These helpers arbitrate that race — a recency rule so a staler poll cannot
 * clobber a fresher edit, create markers so a raced poll cannot drop a
 * just-created row, and delete tombstones so it cannot resurrect a just-deleted
 * one.
 *
 * Extracted from `use-trace-comments.ts` (ISS-5022) so the hook file holds the
 * React wiring and this module holds the pure list reconciliation, which is
 * independently readable and testable.
 */

/**
 * How long a client-side delete tombstone survives before it is force-expired.
 * A concurrent poll that was already in flight when a comment was deleted can
 * return the still-present row and resurrect it; the tombstone suppresses that
 * row until the server reflects the delete. The TTL is a backstop so a
 * tombstone can never leak permanently if the server never returns the id again
 * (e.g. the row falls out of the visible page).
 *
 * The window is sized to outlast one in-flight request, NOT N poll cycles: since
 * ISS-5022 the poll cadence is adaptive (it backs off to 30s once a thread has
 * been idle), so "three poll cycles" is no longer a fixed duration. The value is
 * unchanged. A local mutation both zeroes the idle streak and re-aims the pending
 * timer, so the cadence is genuinely back at the base interval afterwards and
 * this window still covers three confirming reads exactly as it did before.
 */
export const TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS =
  TRACE_COMMENTS_REFETCH_INTERVAL_MS * 3;

/**
 * How long a client-side create marker survives before it is force-expired.
 * A poll that was already in flight when a comment or reply was created locally
 * returns the pre-create list; without protection the merge would drop the
 * just-created row (the server list omits it) and the new comment/reply would
 * flicker away until the next poll. The marker preserves the locally-created
 * row until the server list reflects it (or the TTL backstop fires), mirroring
 * the delete tombstone. Same window, and sized the same way — see the tombstone
 * note above on why this is an in-flight-request budget, not a poll-cycle count.
 */
export const TRACE_COMMENT_CREATE_MARKER_TTL_MS =
  TRACE_COMMENTS_REFETCH_INTERVAL_MS * 3;

export function mergeTraceComments(
  current: readonly TraceComment[],
  incoming: TraceComment
): TraceComment[] {
  const existing = current.find((item) => item.id === incoming.id);
  const winner = existing ? pickFresherComment(existing, incoming) : incoming;
  const withoutDuplicate = current.filter((item) => item.id !== incoming.id);
  return sortByCreatedAtThenId([...withoutDuplicate, winner]);
}

/**
 * Merges a full server list (poll result) against the current cache, keeping the
 * fresher version per comment id so a staler in-flight poll cannot overwrite a
 * fresher local edit. Comment ids absent from `incoming` are dropped (the server
 * no longer returns them), which is the steady state after a delete is
 * reflected — unless the id carries an active create marker, in which case the
 * cached row is preserved so a poll that raced a local create cannot drop the
 * just-created comment. A `pickFresherComment` winner that lost a locally-marked
 * reply likewise has that reply re-attached.
 */
export function mergeTraceCommentList(
  current: readonly TraceComment[],
  incoming: readonly TraceComment[],
  createMarkers?: ReadonlyMap<string, number>
): TraceComment[] {
  const currentById = new Map(current.map((comment) => [comment.id, comment]));
  const incomingIds = new Set(incoming.map((comment) => comment.id));
  const merged = incoming.map((comment) => {
    const existing = currentById.get(comment.id);
    const winner = existing ? pickFresherComment(existing, comment) : comment;
    return existing
      ? preserveMarkedReplies(existing, winner, createMarkers)
      : winner;
  });
  // Re-attach any cached comment that the server list omitted but that still
  // carries an active create marker (a poll that predates the local create).
  const preserved = current.filter(
    (comment) =>
      !incomingIds.has(comment.id) &&
      isCreateMarkerActive(createMarkers, comment.id)
  );
  return sortByCreatedAtThenId([...merged, ...preserved]);
}

/**
 * Re-attaches replies present on the cached comment but missing from the merge
 * winner when those replies carry an active create marker. Without this, a poll
 * that raced a local reply create (whose list still shows the pre-reply thread,
 * since a reply write does not bump the root's updatedAt server-side) would win
 * `pickFresherComment` on a tie and silently drop the just-created reply. A
 * reply the winner legitimately dropped without a marker (e.g. deleted on
 * another surface) is left dropped.
 */
function preserveMarkedReplies(
  cached: TraceComment,
  winner: TraceComment,
  createMarkers?: ReadonlyMap<string, number>
): TraceComment {
  const winnerReplyIds = new Set(
    (winner.replies ?? []).map((reply) => reply.id)
  );
  const markedMissing = (cached.replies ?? []).filter(
    (reply) =>
      !winnerReplyIds.has(reply.id) &&
      isCreateMarkerActive(createMarkers, reply.id)
  );
  if (markedMissing.length === 0) {
    return winner;
  }
  return {
    ...winner,
    replies: [...(winner.replies ?? []), ...markedMissing],
  };
}

/**
 * Returns the fresher of two versions of the same comment by comparing a
 * reply-aware freshness signal (the max of the root's `updatedAt` and every
 * reply's `updatedAt`, each falling back to `createdAt`). The root's `updatedAt`
 * alone is not sufficient: a reply write (create/edit/delete a reply) does NOT
 * bump the root comment's `updatedAt` server-side — a reply is a sibling
 * `comment` row and only its own row carries the fresh timestamp — so comparing
 * the root alone would let a staler in-flight poll (taken before a reply edit)
 * tie the root timestamp and win, dropping the fresher reply set. Taking the
 * max over the whole thread makes a version that carries a newer reply win.
 * Ties keep `incoming` so a server echo of a local edit is idempotent. The
 * winner's replies are taken as-is (a reply the winner dropped stays dropped);
 * locally-created replies that a raced poll omits are re-attached separately via
 * create markers in {@link preserveMarkedReplies}, not by unioning here (which
 * would resurrect a reply the fresher version legitimately deleted).
 */
function pickFresherComment(
  existing: TraceComment,
  incoming: TraceComment
): TraceComment {
  return traceCommentThreadFreshnessMs(incoming) >=
    traceCommentThreadFreshnessMs(existing)
    ? incoming
    : existing;
}

function traceCommentUpdatedAtMs(comment: TraceComment): number {
  return parseTimestampMs(comment.updatedAt ?? comment.createdAt);
}

/**
 * The freshness signal for a whole comment thread: the newest `updatedAt` across
 * the root comment and all of its replies. Used to arbitrate merges so a version
 * carrying a newer reply is treated as fresher even though a reply write leaves
 * the root's own `updatedAt` unchanged server-side.
 */
function traceCommentThreadFreshnessMs(comment: TraceComment): number {
  let newest = traceCommentUpdatedAtMs(comment);
  for (const reply of comment.replies ?? []) {
    const replyMs = parseTimestampMs(reply.updatedAt ?? reply.createdAt);
    if (replyMs > newest) {
      newest = replyMs;
    }
  }
  return newest;
}

/**
 * Drops any comment (or nested reply) whose id has an unexpired delete
 * tombstone, so a poll that raced a delete cannot resurrect the removed row.
 */
export function pruneTombstonedComments(
  incoming: readonly TraceComment[],
  tombstones: ReadonlyMap<string, number>
): TraceComment[] {
  if (tombstones.size === 0) {
    return [...incoming];
  }
  const now = Date.now();
  const isActive = (id: string): boolean => {
    const expiresAt = tombstones.get(id);
    return expiresAt !== undefined && expiresAt > now;
  };
  return incoming
    .filter((comment) => !isActive(comment.id))
    .map((comment) => ({
      ...comment,
      replies: (comment.replies ?? []).filter((reply) => !isActive(reply.id)),
    }));
}

/**
 * Clears a delete tombstone once the server list no longer contains its id (the
 * delete is now reflected), and force-expires any tombstone past its TTL as a
 * backstop against ids the server never returns again.
 */
export function reconcileDeleteTombstones(
  incoming: readonly TraceComment[],
  tombstones: Map<string, number>
): void {
  if (tombstones.size === 0) {
    return;
  }
  const presentIds = new Set<string>();
  for (const comment of incoming) {
    presentIds.add(comment.id);
    for (const reply of comment.replies ?? []) {
      presentIds.add(reply.id);
    }
  }
  const now = Date.now();
  for (const [id, expiresAt] of tombstones) {
    if (!presentIds.has(id) || expiresAt <= now) {
      tombstones.delete(id);
    }
  }
}

/**
 * Records the given comment/reply ids as locally created, each with a fresh TTL,
 * so a poll that raced the create cannot drop the row before the server list
 * reflects it. Re-marking an existing id simply refreshes its expiry.
 */
export function markCreatedIds(
  markers: Map<string, number>,
  ids: string[]
): void {
  const expiresAt = Date.now() + TRACE_COMMENT_CREATE_MARKER_TTL_MS;
  for (const id of ids) {
    markers.set(id, expiresAt);
  }
}

/**
 * Whether a create marker for the given id is present and unexpired. A missing
 * marker map (e.g. the first, cache-empty poll) is treated as no active marker.
 */
function isCreateMarkerActive(
  markers: ReadonlyMap<string, number> | undefined,
  id: string
): boolean {
  if (!markers) {
    return false;
  }
  const expiresAt = markers.get(id);
  return expiresAt !== undefined && expiresAt > Date.now();
}

/**
 * Clears a create marker once the server list contains its id (the create is now
 * reflected), and force-expires any marker past its TTL as a backstop against
 * ids the server never returns again. Mirrors {@link reconcileDeleteTombstones}.
 */
export function reconcileCreateMarkers(
  incoming: readonly TraceComment[],
  markers: Map<string, number>
): void {
  if (markers.size === 0) {
    return;
  }
  const presentIds = new Set<string>();
  for (const comment of incoming) {
    presentIds.add(comment.id);
    for (const reply of comment.replies ?? []) {
      presentIds.add(reply.id);
    }
  }
  const now = Date.now();
  for (const [id, expiresAt] of markers) {
    if (presentIds.has(id) || expiresAt <= now) {
      markers.delete(id);
    }
  }
}

export function removeTraceCommentOrReply(
  current: readonly TraceComment[],
  commentId: string
): TraceComment[] {
  return current
    .filter((comment) => comment.id !== commentId)
    .map((comment) => ({
      ...comment,
      replies: (comment.replies ?? []).filter(
        (reply) => reply.id !== commentId
      ),
    }));
}
