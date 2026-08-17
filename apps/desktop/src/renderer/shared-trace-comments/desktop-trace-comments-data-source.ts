import {
  type BranchTraceCommentCollectionQuery,
  type TraceComment,
  TraceCommentSurface,
  type TraceCommentTarget,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
  isAbortError,
  raceRequestDeadline,
  startApiRequestDeadline,
} from "@repo/app/shared/api/api-timeout";
import { traceCommentKeys } from "@repo/app/shared/trace-comments/trace-comment-query";
import type {
  TraceCommentReadOptions,
  TraceCommentsDataSource,
} from "@repo/app/shared/trace-comments/trace-comments-data-source";
import type { DesktopApi } from "../types/desktop-api";

type DesktopTraceCommentsApi = {
  traceCommentsApi?: DesktopApi["traceCommentsApi"];
};

/**
 * Desktop trace comments are local-first. The main-process IPC implementation
 * persists comments in the local SQLite store and syncs with cloud when the
 * desktop API key and cloud target are available.
 */
export function createDesktopTraceCommentsDataSource(
  desktopApi: DesktopTraceCommentsApi
): TraceCommentsDataSource {
  const traceCommentsApi = desktopApi.traceCommentsApi;
  // One outstanding raw `list` round-trip per collection identity. See
  // `coalesceRead` for why this exists and how it stays bounded.
  const inFlightReads = new Map<string, Promise<TraceComment[]>>();
  return {
    scope: DESKTOP_TRACE_COMMENTS_SCOPE,
    ...(traceCommentsApi?.supportsBranchTraceCommentSurfaces === true
      ? { capabilities: { branchTimelineWrites: true as const } }
      : {}),
    list: async (
      target,
      query?: BranchTraceCommentCollectionQuery,
      options?: TraceCommentReadOptions
    ) => {
      const comments =
        (await readWithinDeadline(
          coalesceRead(inFlightReads, traceCommentsApi, target, query),
          options
        )) ?? [];
      return traceCommentsApi?.supportsBranchTraceCommentSurfaces === true ||
        commentsMatchCollection(target, query, comments)
        ? comments
        : [];
    },
    create: async (
      target,
      draft,
      query?: BranchTraceCommentCollectionQuery
    ) => {
      requireBranchSurfaceWriteCapability(desktopApi, target, query);
      const comment = await requireTraceCommentsApi(desktopApi).create(
        target,
        draft,
        query
      );
      if (!commentsMatchCollection(target, query, [comment])) {
        throw new Error("Desktop trace comment response surface mismatch.");
      }
      return comment;
    },
    reply: (
      target,
      commentId,
      draft,
      query?: BranchTraceCommentCollectionQuery
    ) => {
      requireBranchSurfaceWriteCapability(desktopApi, target, query);
      return requireTraceCommentsApi(desktopApi).reply(
        target,
        commentId,
        draft,
        query
      );
    },
    update: (
      target,
      commentId,
      update,
      query?: BranchTraceCommentCollectionQuery
    ) => {
      requireBranchSurfaceWriteCapability(desktopApi, target, query);
      return requireTraceCommentsApi(desktopApi).update(
        target,
        commentId,
        update,
        query
      );
    },
    delete: (target, commentId, query?: BranchTraceCommentCollectionQuery) => {
      requireBranchSurfaceWriteCapability(desktopApi, target, query);
      return requireTraceCommentsApi(desktopApi).delete(
        target,
        commentId,
        query
      );
    },
  };
}

function commentsMatchCollection(
  target: TraceCommentTarget,
  query: BranchTraceCommentCollectionQuery | undefined,
  comments: readonly TraceComment[]
): boolean {
  const expectedSurface =
    target.type === TraceCommentTargetType.Branch
      ? (query?.surface ?? TraceCommentSurface.BranchDetail)
      : TraceCommentSurface.SessionDetail;
  return comments.every(
    (comment) =>
      comment.target.type === target.type &&
      comment.target.id === target.id &&
      comment.surface === expectedSurface &&
      comment.artifactId.length > 0
  );
}

function requireBranchSurfaceWriteCapability(
  desktopApi: DesktopTraceCommentsApi,
  target: TraceCommentTarget,
  query: BranchTraceCommentCollectionQuery | undefined
): void {
  if (
    target.type === TraceCommentTargetType.Branch &&
    query?.surface === TraceCommentSurface.BranchTimeline &&
    desktopApi.traceCommentsApi?.supportsBranchTraceCommentSurfaces !== true
  ) {
    throw new Error(
      "This Desktop version cannot safely write Branch timeline comments."
    );
  }
}

function requireTraceCommentsApi(
  desktopApi: DesktopTraceCommentsApi
): DesktopApi["traceCommentsApi"] {
  if (!desktopApi.traceCommentsApi) {
    throw new Error("This Desktop version does not support trace comments.");
  }
  return desktopApi.traceCommentsApi;
}

/**
 * Bounds one local IPC read with the caller's signal and deadline (ISS-5110).
 *
 * The main-process `list` round-trip has no cancellation of its own and cannot
 * get one without a gateway contract change: an `AbortSignal` does not survive
 * structured cloning across the bridge. So the renderer stops WAITING instead —
 * the request may still be in flight in main, but the read rejects, the rail's
 * single-flight guard is released, and the next poll runs. A read wedged on a
 * stuck IPC round-trip no longer blocks every subsequent poll for the surface.
 *
 * Abandoning the wait is only half of it. Because the deadline releases that
 * single-flight guard, the next poll would otherwise issue a SECOND IPC call
 * while the first is still wedged, and a permanently stuck handler would collect
 * one more pending call every cycle. {@link coalesceRead} caps that at one
 * outstanding round-trip per collection; this function still owns the per-caller
 * waiting policy.
 *
 * A deadline expiry is reported as the same `ApiError` the HTTP path produces
 * for the same fact, so both surfaces classify it identically: not retried
 * (`shouldRetryQuery`), and "we stopped waiting" rather than "the store said
 * no". A caller abort stays a bare `AbortError`, which React Query treats as a
 * cancellation rather than a failure.
 */
async function readWithinDeadline(
  work: Promise<TraceComment[]> | undefined,
  options: TraceCommentReadOptions | undefined
): Promise<TraceComment[] | undefined> {
  if (!work) {
    return;
  }
  const deadline = startApiRequestDeadline(options);
  try {
    return await raceRequestDeadline(work, deadline);
  } catch (error) {
    if (isAbortError(error) && deadline.timedOut()) {
      throw new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
        code: API_TIMEOUT_ERROR_CODE,
      });
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

/**
 * Coalesces concurrent raw `list` round-trips per collection identity (ISS-5110,
 * wongk review on #4768).
 *
 * A read that arrives while one is outstanding for the same collection JOINS it
 * instead of launching a second IPC call, so a permanently wedged main-process
 * handler holds exactly one pending round-trip rather than accumulating one per
 * poll cycle. Cancellation at the IPC boundary is not an option here — it needs
 * a gateway contract change, and an `AbortSignal` does not survive structured
 * cloning — so bounding how many calls can be outstanding is the available fix.
 *
 * Coalescing shares the WORK, never the waiting policy: each caller wraps the
 * joined promise in its own {@link readWithinDeadline}, so it keeps its own
 * deadline and its own `AbortError`/`ApiError` classification, and the rail still
 * unblocks on time.
 *
 * The map is bounded by construction — the entry is dropped as soon as the read
 * settles, either way. It tracks the RAW promise rather than a deadline-wrapped
 * one precisely so a caller whose deadline fired first cannot evict an entry
 * whose round-trip is still in flight, which would reopen the leak.
 *
 * Keyed on the same target + normalized-collection identity the cache uses, so
 * two different collections on one target never share a result.
 */
function coalesceRead(
  inFlightReads: Map<string, Promise<TraceComment[]>>,
  traceCommentsApi: DesktopApi["traceCommentsApi"] | undefined,
  target: TraceCommentTarget,
  query: BranchTraceCommentCollectionQuery | undefined
): Promise<TraceComment[]> | undefined {
  if (!traceCommentsApi) {
    return;
  }
  const key = traceCommentKeys
    .target(DESKTOP_TRACE_COMMENTS_SCOPE, target, query)
    .join(":");
  const outstanding = inFlightReads.get(key);
  if (outstanding) {
    return outstanding;
  }
  const read = traceCommentsApi
    .list(target, query)
    .finally(() => inFlightReads.delete(key));
  inFlightReads.set(key, read);
  return read;
}

/** Data-source scope, also the coalescing key prefix. */
const DESKTOP_TRACE_COMMENTS_SCOPE = "desktop-local";

// FEA-3522 note: the former `createCloudReadsLocalWritesTraceCommentsDataSource`
// composite (FEA-3460) split Cloud-mode trace comments into cloud reads + local
// writes only because the cloud-API fetch bridge was GET-only. Now that the
// bridge carries an authenticated write transport (see `cloud-api-fetch-ipc.ts`,
// `WRITE_ALLOWLIST`), Cloud mode uses the plain shared HTTP source (scope
// `"http"`) for reads AND writes — the same pure-HTTP shape Sessions and
// agent-components use — so the composite is gone. Local mode (signed out /
// offline) still uses the local IPC source above, whose SQLite store keeps its
// own `trace-comment-parent-session-cloud-sync` push, so no local comment is
// lost.
