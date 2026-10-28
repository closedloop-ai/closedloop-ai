"use client";

import type {
  BranchTraceCommentCollectionQuery,
  TraceComment,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
  TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  traceCommentKeys as sharedTraceCommentKeys,
  traceCommentsLiveQueryOptions as sharedTraceCommentsLiveQueryOptions,
} from "@repo/app/shared/trace-comments/trace-comment-query";
import {
  assertTraceCommentMutationResult,
  assertTraceCommentWriteSupported,
  executeTraceCommentRetrySync,
  readTraceCommentCollection,
  TraceCommentCollectionMismatchError,
  type TraceCommentsDataSource,
} from "@repo/app/shared/trace-comments/trace-comments-data-source";
import { useTraceCommentsDataSource } from "@repo/app/shared/trace-comments/trace-comments-provider";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TraceCommentItem } from "./trace-comments";
import {
  markCreatedIds,
  mergeTraceCommentList,
  mergeTraceComments,
  pruneTombstonedComments,
  reconcileCreateMarkers,
  reconcileDeleteTombstones,
  removeTraceCommentOrReply,
  TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS,
} from "./trace-comments-merge";
import { TRACE_COMMENTS_READ_TIMEOUT_MS } from "./trace-comments-poll-cadence";
import { useTraceCommentsLiveUpdates } from "./use-trace-comments-live-updates";

/**
 * Shared live-read query defaults for trace comments. Web and desktop both opt
 * this target-scoped query into immediate staleness so a focus or reconnect
 * fetches the lightweight comments payload once rather than waiting for the
 * full session or branch detail payload to refresh.
 *
 * The query also opts out of the shared auth-rejection boundary (FEA-3940) via
 * `meta.ownsAuthRejection`: a 401, or a bare 403, on a target-scoped
 * `/…/trace-comments` read means "you can't see the comments on THIS
 * session/branch," a per-resource authorization state the detail surface handles
 * inline — not "your whole session is dead." Without the opt-out that
 * per-resource 401 would trip the web shell's global `WorkspaceAuthGuard` and
 * blank the entire session detail page (the canonical case is the same as
 * `useBranchView`'s "Access required" panel). A response the server tagged with
 * an `AuthErrorCode` overrides the opt-out (ISS-5095, any tagged code since
 * ISS-5118) — that one is not about this resource, and no inline state can
 * explain it.
 */
// biome-ignore lint/performance/noBarrelFile: compatibility export for existing direct consumers.
export {
  traceCommentKeys,
  traceCommentsLiveQueryOptions,
} from "@repo/app/shared/trace-comments/trace-comment-query";

type UseTraceCommentsOptions = {
  target: TraceCommentTarget;
  /** Exact Branch comment collection; omission normalizes to Branch detail. */
  collection?: BranchTraceCommentCollectionQuery;
  /** Consumer-specific row jump implementation, e.g. shared session trace or branch playhead. */
  onJumpToRow: (row: number, flash: boolean) => void;
  /**
   * Whether the reader has left the comments surface open (header toggle on and
   * not collapsed by the reader). When `false`, the fallback poll never runs.
   * Defaults to `true` for callers that always render the rail.
   *
   * Document visibility is deliberately not consulted: a desktop Electron
   * renderer can report `document.visibilityState === "hidden"` indefinitely (an
   * offscreen/CI window) and never fire `visibilitychange`, so any dependence on
   * that signal would stall a reader who is genuinely looking at the comments.
   */
  active?: boolean;
  /**
   * Whether the surface stays expanded while the list is settled empty. The
   * session rail collapses to its handle until comments exist unless the reader
   * revealed it (FEA-4233), and a collapsed handle only polls while push is not
   * live (ISS-12275). Defaults to `true` for callers that always render the rail.
   */
  expandedWhenEmpty?: boolean;
  /**
   * False: no read and no poll at all. The Session shell turns the legacy
   * collection off when the unified comments pane hosts this Session's
   * comments instead (PLN-2162 M6).
   */
  enabled?: boolean;
  /** Include the addressed thread even when it falls beyond the collection cap. */
  includeThreadId?: string;
};

/**
 * Owns persisted trace comments for shared trace surfaces. The query reads the
 * lightweight comments endpoint so web and desktop see each other's comments
 * without refreshing the full session or branch detail payload; the comment
 * event stream pushes changes, with a 30s fallback poll (ISS-12275, see
 * `useTraceCommentsLiveUpdates`).
 */
export function useTraceComments({
  target,
  collection,
  onJumpToRow,
  active = true,
  expandedWhenEmpty = true,
  enabled = true,
  includeThreadId,
}: UseTraceCommentsOptions) {
  const isLive = active && enabled;
  const dataSource = useTraceCommentsDataSource();
  const queryClient = useQueryClient();
  const [activeAnchor, setActiveAnchor] = useState<TraceTextAnchor | null>(
    null
  );
  const targetQueryKey = sharedTraceCommentKeys.target(
    dataSource.scope,
    target,
    collection
  );
  const queryKey = includeThreadId
    ? [...targetQueryKey, { includeThreadId }]
    : targetQueryKey;

  // Short-lived record of ids deleted on this client, keyed by id → expiry ms.
  // A poll that raced a delete can still return the row; we drop tombstoned ids
  // from the incoming list until the server stops returning them (or the TTL
  // backstop fires), so an in-flight poll cannot resurrect a just-deleted
  // comment. Held in a ref so mutating it never re-renders the hook.
  const deleteTombstonesRef = useRef<Map<string, number>>(new Map());

  // Short-lived record of comment/reply ids this client just created, keyed by
  // id → expiry ms. A poll that raced the create returns the pre-create list;
  // we preserve the locally-created row from the cache until the server list
  // includes the id (or the TTL backstop fires), so an in-flight poll cannot
  // drop a just-created comment or reply. Held in a ref so mutating it never
  // re-renders the hook. Mirrors `deleteTombstonesRef` for the create side.
  const createMarkersRef = useRef<Map<string, number>>(new Map());

  const commentsQuery = useQuery({
    queryKey,
    // Merge the server list against the current cache with a recency rule so an
    // already-in-flight, staler poll cannot clobber a fresher local edit,
    // preserve just-created comments/replies via create markers so a poll that
    // raced the create cannot drop them, and apply active delete tombstones so
    // it cannot resurrect a just-deleted comment.
    //
    // FEA-4233: `enabled` is gated on `target.id` alone, NOT on `active`, so the
    // query performs a one-shot discovery read even while the rail is collapsed.
    // The session-detail surface defaults a comments rail collapsed only when it
    // is genuinely empty; that decision needs the comment count, which is only
    // known once the list resolves.
    //
    // ISS-5110: the read is issued with TanStack's own `signal` and a deadline
    // (`TRACE_COMMENTS_READ_TIMEOUT_MS`), so a wedged request
    // is cancelled and fails instead of occupying the transport indefinitely.
    // On desktop the deadline is what crosses the cloud-IPC bridge (a signal
    // cannot), and the local IPC source honours both itself.
    queryFn: async ({ signal }) => {
      const read = await readTraceCommentCollection(
        dataSource,
        target,
        collection,
        {
          signal,
          timeoutMs: TRACE_COMMENTS_READ_TIMEOUT_MS,
          ...(includeThreadId ? { includeThreadId } : {}),
        }
      );
      if (read.rejectedCount > 0) {
        throw new TraceCommentCollectionMismatchError();
      }
      const incoming = read.comments;
      const tombstones = deleteTombstonesRef.current;
      const survivors = pruneTombstonedComments(incoming, tombstones);
      reconcileDeleteTombstones(incoming, tombstones);
      const cached = queryClient.getQueryData<TraceComment[]>(queryKey);
      if (!cached) {
        return survivors;
      }
      const markers = createMarkersRef.current;
      const merged = mergeTraceCommentList(cached, survivors, markers);
      reconcileCreateMarkers(survivors, markers);
      return merged;
    },
    enabled: enabled && Boolean(target.id),
    ...sharedTraceCommentsLiveQueryOptions,
  });
  const refetchTraceComments = commentsQuery.refetch;

  // FEA-4233: whether THIS mount+target has completed at least one successful
  // discovery fetch. `commentsQuery.isSuccess` alone is not enough: with
  // `staleTime: 0` a remount over a cached (possibly empty) list starts in
  // `isSuccess` from that cache while its own refetch is still in flight — so a
  // session reopened after another surface added a comment would read as settled
  // empty, collapse the rail from the cached `[]`, then pop it open when the
  // refetch returns. Latch on `isFetchedAfterMount` so the settled-empty signal
  // only fires once this mount's own read lands, and keep it latched across
  // later poll failures (a transient refetch error must not un-settle a rail
  // that already loaded). Reset when the target changes (a new session is a new
  // discovery).
  const loadedTargetRef = useRef<string | null>(null);
  const hasLoadedForTargetRef = useRef(false);
  if (loadedTargetRef.current !== queryKeyString(queryKey)) {
    loadedTargetRef.current = queryKeyString(queryKey);
    hasLoadedForTargetRef.current = false;
  }
  if (commentsQuery.isSuccess && commentsQuery.isFetchedAfterMount) {
    hasLoadedForTargetRef.current = true;
  }
  const hasLoadedComments = hasLoadedForTargetRef.current;

  const commentCount = commentsQuery.data?.length ?? 0;
  useTraceCommentsLiveUpdates({
    // A disabled collection joins no channel either: a signal's reload would
    // otherwise read through `refetch`, which ignores the query's `enabled`.
    targetId: enabled ? target.id : "",
    queryIdentity: queryKeyString(queryKey),
    refetch: refetchTraceComments,
    dataLoadedAt: () =>
      queryClient.getQueryState(queryKey)?.dataUpdatedAt || undefined,
    active: isLive,
    expanded:
      isLive && (expandedWhenEmpty || (hasLoadedComments && commentCount > 0)),
  });

  const comments = useMemo(
    () => (commentsQuery.data ?? []).map(toTraceCommentItem),
    [commentsQuery.data]
  );

  const createMutation = useMutation({
    mutationFn: async (draft: TraceCommentDraft) => {
      assertTraceCommentWriteSupported(dataSource, target, collection);
      return assertTraceCommentMutationResult(
        await executeTraceCommentCreate(dataSource, target, draft, collection),
        target,
        collection
      );
    },
    onSuccess: (created) => {
      setActiveAnchor(created.anchor);
      // Mark the new id so a poll that raced this create cannot drop it before
      // the server list reflects it.
      markCreatedIds(createMarkersRef.current, [created.id]);
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        mergeTraceComments(current, created)
      );
    },
    onError: () => {
      setActiveAnchor(null);
      toast.error("Failed to save trace comment. Please try again.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      commentId,
      update,
    }: {
      commentId: string;
      update: TraceCommentUpdate;
    }) => {
      assertTraceCommentWriteSupported(dataSource, target, collection);
      return executeTraceCommentUpdate(
        dataSource,
        target,
        commentId,
        update,
        collection
      ).then((comment) =>
        assertTraceCommentMutationResult(comment, target, collection)
      );
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        mergeTraceComments(current, updated)
      );
    },
  });

  const replyMutation = useMutation({
    mutationFn: ({
      commentId,
      draft,
    }: {
      commentId: string;
      draft: TraceCommentReplyDraft;
    }) => {
      assertTraceCommentWriteSupported(dataSource, target, collection);
      return executeTraceCommentReply(
        dataSource,
        target,
        commentId,
        draft,
        collection
      ).then((comment) =>
        assertTraceCommentMutationResult(comment, target, collection)
      );
    },
    onSuccess: (updated) => {
      // Mark the reply ids so a poll that raced this reply create — one whose
      // list still shows the pre-reply thread, since a reply write does not
      // bump the root comment's updatedAt server-side — cannot drop the new
      // reply set before the server reflects it.
      markCreatedIds(
        createMarkersRef.current,
        (updated.replies ?? []).map((reply) => reply.id)
      );
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        mergeTraceComments(current, updated)
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (commentId: string) => {
      assertTraceCommentWriteSupported(dataSource, target, collection);
      return executeTraceCommentDelete(
        dataSource,
        target,
        commentId,
        collection
      );
    },
    onSuccess: (_deleted, commentId) => {
      // Tombstone the id first so a poll that resolves between here and the
      // next render cannot re-add the row we are about to remove.
      deleteTombstonesRef.current.set(
        commentId,
        Date.now() + TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS
      );
      // If this id was just created locally, drop its create marker so the
      // tombstone (which suppresses the row) is not fought by the marker (which
      // would preserve it) — a delete always wins over a pending local create.
      createMarkersRef.current.delete(commentId);
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        removeTraceCommentOrReply(current, commentId)
      );
    },
  });

  // ISS-8597 (PRD-699 §5 D2): the recovery door on a dead-lettered comment. The
  // source answers with the target's refreshed list rather than one comment,
  // because re-pending changes the row's sync state and nothing else — there is
  // no single-comment payload to merge, and the list is what the badge reads.
  const retrySyncMutation = useMutation({
    mutationFn: (commentId: string) => {
      assertTraceCommentWriteSupported(dataSource, target, collection);
      return executeTraceCommentRetrySync(
        dataSource,
        target,
        commentId,
        collection
      );
    },
    onSuccess: (refreshed) => {
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        mergeTraceCommentList(current, refreshed, createMarkersRef.current)
      );
    },
    onError: () => {
      toast.error("Could not retry this comment. Please try again.");
    },
  });

  const submitTraceComment = useCallback(
    (draft: TraceCommentDraft, options?: { onSuccess?: () => void }) => {
      createMutation.mutate(draft, {
        // Runs after the create succeeds and in addition to the mutation's own
        // onSuccess (anchor + cache write), so callers can gate side effects
        // such as revealing a collapsed rail on the comment actually persisting.
        onSuccess: () => options?.onSuccess?.(),
      });
    },
    [createMutation]
  );

  const jumpToTraceComment = useCallback(
    (row: number, flash = true, anchor?: TraceTextAnchor) => {
      if (anchor) {
        setActiveAnchor(anchor);
      }
      onJumpToRow(row, flash);
    },
    [onJumpToRow]
  );

  const updateTraceComment = useCallback(
    (commentId: string, update: TraceCommentUpdate) => {
      updateMutation.mutate({ commentId, update });
    },
    [updateMutation]
  );

  const replyToTraceComment = useCallback(
    (commentId: string, draft: TraceCommentReplyDraft) => {
      replyMutation.mutate({ commentId, draft });
    },
    [replyMutation]
  );

  const deleteTraceComment = useCallback(
    (commentId: string) => {
      deleteMutation.mutate(commentId);
    },
    [deleteMutation]
  );

  // Undefined when the source cannot dead-letter a comment, so the rail has
  // nothing to render a retry affordance from — the port's SHAPE decides that,
  // not a surface flag. Since ISS-10382 the cloud HTTP source is no longer such
  // a source; a version-skewed desktop bridge is.
  const canRetrySync = Boolean(dataSource.retrySync);
  // Depends on `.mutate`, not on the mutation object: TanStack's `useMutation`
  // returns a fresh object literal every render, so a dep on it recomputes this
  // callback every render and hands the rail a new identity per comment card.
  // `.mutate` is the stable half.
  const retrySyncMutate = retrySyncMutation.mutate;
  const retryTraceCommentSync = useMemo(
    () =>
      canRetrySync
        ? (commentId: string) => {
            retrySyncMutate(commentId);
          }
        : undefined,
    [canRetrySync, retrySyncMutate]
  );

  return {
    activeAnchor,
    comments,
    // FEA-4233: whether THIS mount+target has settled at least one successful
    // discovery read, so a consumer can tell "no comments yet, still loading"
    // apart from "settled empty" before defaulting an empty rail collapsed.
    // Latched on `isFetchedAfterMount` (not bare `isSuccess`) so a cached empty
    // list from a prior mount does not read as authoritatively empty while this
    // mount's own read is still in flight — see the latch above.
    hasLoadedComments,
    isSyncing:
      commentsQuery.isFetching ||
      createMutation.isPending ||
      replyMutation.isPending ||
      updateMutation.isPending ||
      deleteMutation.isPending ||
      retrySyncMutation.isPending,
    deleteTraceComment,
    jumpToTraceComment,
    replyToTraceComment,
    retryTraceCommentSync,
    submitTraceComment,
    updateTraceComment,
  };
}

function toTraceCommentItem(comment: TraceComment): TraceCommentItem {
  const replies = comment.replies ?? [];
  return {
    ...comment,
    createdAtLabel: formatRelativeTimeOrFallback(comment.createdAt, {
      fallback: "Just now",
    }),
    replies: replies.map((reply) => ({
      ...reply,
      createdAtLabel: formatRelativeTimeOrFallback(reply.createdAt, {
        fallback: "Just now",
      }),
    })),
  };
}

/**
 * Stable string identity for a trace-comments query key, used to detect a target
 * change so the per-mount "has loaded" latch resets for a new session/branch.
 */
function queryKeyString(queryKey: readonly unknown[]): string {
  return JSON.stringify(queryKey);
}

function executeTraceCommentCreate(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  collection?: BranchTraceCommentCollectionQuery
) {
  return collection === undefined
    ? dataSource.create(target, draft)
    : dataSource.create(target, draft, collection);
}

function executeTraceCommentUpdate(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  commentId: string,
  update: TraceCommentUpdate,
  collection?: BranchTraceCommentCollectionQuery
) {
  return collection === undefined
    ? dataSource.update(target, commentId, update)
    : dataSource.update(target, commentId, update, collection);
}

function executeTraceCommentReply(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  commentId: string,
  draft: TraceCommentReplyDraft,
  collection?: BranchTraceCommentCollectionQuery
) {
  return collection === undefined
    ? dataSource.reply(target, commentId, draft)
    : dataSource.reply(target, commentId, draft, collection);
}

function executeTraceCommentDelete(
  dataSource: TraceCommentsDataSource,
  target: TraceCommentTarget,
  commentId: string,
  collection?: BranchTraceCommentCollectionQuery
) {
  return collection === undefined
    ? dataSource.delete(target, commentId)
    : dataSource.delete(target, commentId, collection);
}
