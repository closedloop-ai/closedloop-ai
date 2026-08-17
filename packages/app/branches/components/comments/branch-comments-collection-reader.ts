import type {
  BranchTraceCommentCollectionQuery,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import { isAbortError } from "@repo/app/shared/api/api-timeout";
import { traceCommentKeys } from "@repo/app/shared/trace-comments/trace-comment-query";
import {
  readTraceCommentCollection,
  type TraceCommentCollectionRead,
  type TraceCommentReadOptions,
  type TraceCommentsDataSource,
} from "@repo/app/shared/trace-comments/trace-comments-data-source";

export type BranchCommentCollection = {
  target: TraceCommentTarget;
  collectionQuery?: BranchTraceCommentCollectionQuery;
};

export type BranchCommentCollectionResult = {
  collection: BranchCommentCollection;
  error: unknown | null;
  read: TraceCommentCollectionRead;
};

/**
 * Reads exact comment collections in bounded chunks. Each target retains its
 * own result so one unavailable Session cannot erase already-loaded peers.
 *
 * `options` carries the caller's cancellation and read deadline (ISS-5110) to
 * every collection in the fan-out, so a cancelled or wedged workspace read stops
 * waiting instead of holding one request per target open.
 *
 * The two failures are NOT the same fact and are not treated the same (wongk
 * review on #4768):
 *
 * - OUR OWN deadline expiring on one target is a per-target failure. It lands in
 *   that result's `error`, the peers already read are kept, and the fan-out
 *   continues — the reason this function exists.
 * - The CALLER aborting (React Query cancelling a superseded or unmounted query)
 *   is not a per-target fact at all. Recording it as one would let the loop keep
 *   scheduling chunks — issuing a request per remaining collection — for a result
 *   that is already discarded. So it propagates and stops the fan-out, and the
 *   signal is checked before each chunk and each collection so no further request
 *   is launched once it is aborted. React Query treats the rejection as a
 *   cancellation rather than a failure.
 *
 * Telling them apart is safe because a deadline expiry never reaches here as a
 * bare `AbortError`: both the HTTP client (`toApiClientError`) and the desktop
 * IPC source (`readWithinDeadline`) convert their own timeout to an `ApiError`
 * first, and re-throw only a caller abort unchanged.
 */
export async function readBranchCommentCollections(
  dataSource: TraceCommentsDataSource,
  collections: readonly BranchCommentCollection[],
  options?: TraceCommentReadOptions
): Promise<BranchCommentCollectionResult[]> {
  const results: BranchCommentCollectionResult[] = [];
  for (
    let index = 0;
    index < collections.length;
    index += BRANCH_COMMENTS_READ_CONCURRENCY
  ) {
    options?.signal?.throwIfAborted();
    const chunk = collections.slice(
      index,
      index + BRANCH_COMMENTS_READ_CONCURRENCY
    );
    const chunkResults = await Promise.all(
      chunk.map((collection) =>
        readOneCollection(dataSource, collection, options)
      )
    );
    results.push(...chunkResults);
  }
  return results;
}

/** Stable cache-key segment for one target plus normalized collection. */
export function branchCommentCollectionIdentity(
  collection: BranchCommentCollection
): string {
  return traceCommentKeys
    .target("collection", collection.target, collection.collectionQuery)
    .slice(2)
    .join(":");
}

/**
 * Reads one collection, keeping its failure local — except a caller abort, which
 * is re-thrown so the fan-out stops instead of recording a cancellation as a
 * per-target failure.
 */
async function readOneCollection(
  dataSource: TraceCommentsDataSource,
  collection: BranchCommentCollection,
  options: TraceCommentReadOptions | undefined
): Promise<BranchCommentCollectionResult> {
  options?.signal?.throwIfAborted();
  try {
    return {
      collection,
      error: null,
      read: await readTraceCommentCollection(
        dataSource,
        collection.target,
        collection.collectionQuery,
        options
      ),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      collection,
      error,
      read: { comments: [], rejectedCount: 0 },
    };
  }
}

/**
 * True when the fan-out ran and NOT ONE collection came back (ISS-5110, wongk
 * review on #4768).
 *
 * The caller turns this into a query-level failure. Resolving it as a list of
 * empty-with-an-error results reads to TanStack as a SUCCESS, which is what left
 * this surface permanently unavailable: no error state, so no retry and no
 * recovery path, on a query that has no poll to fall back on. Partial success
 * stays partial — one unavailable Session must still not erase its peers, which
 * is the reason this reader keeps per-target results at all.
 */
export function everyBranchCommentCollectionFailed(
  results: readonly BranchCommentCollectionResult[]
): boolean {
  return results.length > 0 && results.every((result) => result.error !== null);
}

export const BRANCH_COMMENTS_READ_CONCURRENCY = 4;

/**
 * Deadline for ONE collection read in this fan-out (ISS-5110, wongk review).
 *
 * Deliberately NOT the Session rail's `TRACE_COMMENTS_READ_TIMEOUT_MS`, which is
 * derived from that rail's 2s poll cadence: this query has no poll, so borrowing
 * the number tied this surface's budget to a value that may be retuned for
 * reasons that have nothing to do with it.
 *
 * Sized for what this path is instead — a one-shot, user-initiated read whose
 * wait multiplies by the number of chunks it takes to cover the workspace
 * (`BRANCH_COMMENTS_READ_CONCURRENCY` collections at a time). A generous
 * per-collection budget would compound into a long silent wait before the
 * workspace can state that comments are unavailable, so it stays small; recovery
 * is {@link BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS}, not a longer wait.
 */
export const BRANCH_COMMENTS_READ_TIMEOUT_MS = 5000;

/**
 * How often to re-attempt a Branch comments read that failed OUTRIGHT.
 *
 * The recovery policy this surface was missing. It has no poll, and a
 * client-deadline timeout is never retried (`shouldRetryQuery`), so before this
 * an all-failed read stranded the rail on "Comments are unavailable in this
 * view." until some unrelated invalidation happened to refresh it.
 *
 * Applied ONLY while the query is in an error state, so a healthy workspace
 * still issues no background traffic at all. 30s is the same order as the
 * Session rail's idle back-off ceiling: unattended recovery within a reader's
 * attention span, at a cost that is negligible for a surface that is already
 * broken.
 */
export const BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS = 30_000;
