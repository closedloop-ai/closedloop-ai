import type { TraceComment } from "@repo/api/src/types/comment";

/**
 * Poll cadence for the trace-comments live read (ISS-5022).
 *
 * The comments surface polls a lightweight endpoint so web, desktop, and mobile
 * see each other's comments without refreshing the full session or branch detail
 * payload. At a flat 2s that costs 43,200 requests/day for as long as a page is
 * open — measured in production at ~44% of ALL prod API requests, sustained
 * overnight on sessions nobody was reading.
 *
 * This module owns the "how often" decision as pure functions so the hook keeps
 * only the wiring. Nothing here reads the DOM or React state: the caller passes
 * the current visibility, which is what lets this be unit-tested directly and
 * lets a React Native runtime (no `document` at all) fall through to the base
 * cadence instead of crashing.
 */

/** Base cadence while a reader is actively working a visible thread. */
export const TRACE_COMMENTS_REFETCH_INTERVAL_MS = 2000;

/**
 * Backed-off cadence for a thread that has gone quiet. 30s keeps an idle surface
 * eventually-consistent — the point of the poll — at 1/15th the request cost.
 */
export const TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS = 30_000;

/**
 * Deadline for ONE live read (ISS-5110), passed to the transport as the shared
 * API client's per-call `timeoutMs` override.
 *
 * Derived from the base cadence rather than stated as its own number, because
 * the only thing that makes a value correct here is its relationship to the two
 * windows around it:
 *
 * - It must be SHORTER than `TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS` /
 *   `TRACE_COMMENT_CREATE_MARKER_TTL_MS` (both `interval * 3`). A read that
 *   outlives those windows can land after its own tombstone expired and
 *   resurrect a deleted comment; bounding the read below the TTL removes that
 *   race instead of relying on it losing. Expressed as `interval * 2` so the
 *   inequality holds by construction if the cadence is ever retuned.
 * - Two full poll cycles is also the point past which waiting is pointless: the
 *   loop has already scheduled the next read, so a slower answer is a superseded
 *   one. The default 60s client deadline (`DEFAULT_API_TIMEOUT_MS`) is the wrong
 *   size for a 2s poll — it is a page-load budget, not a poll budget.
 *
 * The consequence, deliberately: a read slower than this now FAILS rather than
 * arriving late. It is not retried (`shouldRetryQuery` never retries a client
 * timeout), and the next scheduled poll is the recovery path.
 */
export const TRACE_COMMENTS_READ_TIMEOUT_MS =
  TRACE_COMMENTS_REFETCH_INTERVAL_MS * 2;

/**
 * Consecutive unchanged polls before the idle back-off engages. 30 polls at the
 * base cadence is ~60s of a thread with no local or remote activity, which is
 * long enough that an active back-and-forth never backs off mid-conversation.
 */
export const TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF = 30;

/**
 * Resolves the delay before the next poll.
 *
 * Thread activity is the ONLY input. Document visibility is deliberately not
 * consulted, even to widen the interval: `apps/desktop`'s own
 * `sessions-list-poll-defaults.ts` documents that an offscreen Electron renderer
 * "can report `document.hidden` indefinitely" and never fires
 * `visibilitychange`, and that surface mounts this rail. Backing off on that
 * signal would permanently drop a reader who IS looking at the comments to the
 * ceiling, with no reset path (TanStack's `focusManager.isFocused()` falls back
 * to the same lying `visibilityState`, so even the focus re-aim could not rescue
 * it) and nothing on screen saying the list is behind.
 *
 * Hidden browser tabs need no help from us either: the browser already throttles
 * their timers to roughly once a minute, which measurement confirmed — the
 * production traffic this issue is about came from VISIBLE windows left open on
 * threads nobody was reading, which is exactly what the idle streak catches.
 *
 * Deliberately a flat guard chain (no nested ternaries) per the repo style rules.
 */
export function resolveTraceCommentsPollDelayMs({
  idleStreak,
}: {
  /** Consecutive polls that returned an unchanged list. */
  idleStreak: number;
}): number {
  if (idleStreak >= TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF) {
    return TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS;
  }
  return TRACE_COMMENTS_REFETCH_INTERVAL_MS;
}

/**
 * A stable identity for a rendered comment list, used to detect whether a poll
 * actually changed anything.
 *
 * Uses `updatedAt ?? createdAt` for both roots and replies — the SAME fallback
 * `traceCommentThreadFreshnessMs` applies when arbitrating merges. Comparing on
 * bare `updatedAt` would collapse to `undefined` for rows that carry only
 * `createdAt` and silently miss changes the merge logic does treat as meaningful.
 *
 * Replies are included because a reply write does NOT bump the root comment's
 * `updatedAt` server-side (a reply is a sibling row carrying its own timestamp),
 * so a root-only signature would read a new or edited reply as "no change".
 *
 * `status`/`resolvedAt` are included for the same reason, one level up: the API
 * maps them off the THREAD row (`service.ts` `status: row.status`) while
 * `updatedAt` comes off the root COMMENT row, so resolving or unresolving a
 * thread on another surface changes the payload without moving any timestamp
 * this signature would otherwise look at.
 */
export function traceCommentListSignature(
  comments: readonly TraceComment[]
): string {
  return comments
    .map((comment) => {
      const replies = (comment.replies ?? [])
        .map((reply) => `${reply.id}@${reply.updatedAt ?? reply.createdAt}`)
        .join(",");
      const resolution = `${comment.status}/${comment.resolvedAt ?? ""}`;
      return `${comment.id}@${comment.updatedAt ?? comment.createdAt}:${resolution}[${replies}]`;
    })
    .join("|");
}
