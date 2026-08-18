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
  readTraceCommentCollection,
  TraceCommentCollectionMismatchError,
  type TraceCommentsDataSource,
} from "@repo/app/shared/trace-comments/trace-comments-data-source";
import { useTraceCommentsDataSource } from "@repo/app/shared/trace-comments/trace-comments-provider";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  focusManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  resolveTraceCommentsPollDelayMs,
  TRACE_COMMENTS_READ_TIMEOUT_MS,
  TRACE_COMMENTS_REFETCH_INTERVAL_MS,
  traceCommentListSignature,
} from "./trace-comments-poll-cadence";

/**
 * Shared live-read query defaults for trace comments. Web and desktop both opt
 * this target-scoped query into immediate staleness so focus/reconnect events
 * always fetch the lightweight comments payload rather than waiting for the
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
   * Whether the comments surface is currently shown (rail open / not collapsed).
   * When `false`, the 2s poll is suspended so a hidden or collapsed rail does
   * not burn IPC/HTTP on desktop keep-alive surfaces. Defaults to `true` so
   * callers that always render the rail keep the existing cadence.
   *
   * This is the SOLE gate on the poll. Document visibility is deliberately not
   * consulted at all — not to gate it, and not to widen the interval either: a
   * desktop Electron renderer can report `document.visibilityState === "hidden"`
   * indefinitely (an offscreen/CI window) and never fire `visibilitychange`, so
   * ANY dependence on that signal degrades a reader who is genuinely looking at
   * the comments, with no reset path. This mirrors the Sessions list/detail
   * fallback poll (`applyDesktopSessionsListPollDefaults`, FEA-2187 / FEA-3481),
   * which runs `refetchInterval` with `refetchIntervalInBackground: true`
   * precisely so a permanently-hidden renderer still refreshes.
   */
  active?: boolean;
};

/**
 * Owns persisted trace comments for shared trace surfaces. The query polls the
 * lightweight comments endpoint so web, desktop, and mobile see each other's
 * comments without refreshing the full session or branch detail payload.
 *
 * The poll is gated on/off ONLY by `active` (the comments surface being shown).
 * Its CADENCE is adaptive (ISS-5022): the base 2s applies while the thread is
 * live, widening to a single backed-off ceiling once it has been unchanged for
 * ~60s. A flat 2s cost 43,200 requests/day per open page — measured at ~44% of
 * all production API requests, sustained overnight on sessions nobody was
 * reading.
 *
 * Thread activity is the only cadence input; document visibility is not consulted
 * (see the `active` doc for why that signal cannot be trusted on the desktop
 * renderer). Back-off widens the interval and never stops the loop, and every
 * cadence change routes through `scheduleNextPoll`, which clears the pending
 * timer before setting a new one — so a reset (local mutation, focus, remote
 * change) re-aims an already-pending long timer instead of leaving it to run out.
 */
export function useTraceComments({
  target,
  collection,
  onJumpToRow,
  active = true,
}: UseTraceCommentsOptions) {
  const isPollActive = active;
  const dataSource = useTraceCommentsDataSource();
  const queryClient = useQueryClient();
  const [activeAnchor, setActiveAnchor] = useState<TraceTextAnchor | null>(
    null
  );
  const queryKey = sharedTraceCommentKeys.target(
    dataSource.scope,
    target,
    collection
  );

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
    // it cannot resurrect a just-deleted comment. Keeps the public hook shape
    // and the 2s cadence unchanged.
    //
    // FEA-4233: `enabled` is gated on `target.id` alone, NOT on `active`, so the
    // query performs a one-shot discovery read even while the rail is collapsed.
    // The session-detail surface defaults a comments rail collapsed only when it
    // is genuinely empty; that decision needs the comment count, which is only
    // known once the list resolves. The recurring 2s interval below stays gated
    // on `active`, so a collapsed/hidden rail still does not hammer the endpoint
    // — it just reads once (plus focus/reconnect refetches) to learn whether any
    // comments exist.
    //
    // ISS-5110: the read is issued with TanStack's own `signal` and a deadline
    // sized to the poll (`TRACE_COMMENTS_READ_TIMEOUT_MS`), so a wedged request
    // is cancelled and fails instead of occupying the transport indefinitely.
    // On desktop the deadline is what crosses the cloud-IPC bridge (a signal
    // cannot), and the local IPC source honours both itself.
    queryFn: async ({ signal }) => {
      const read = await readTraceCommentCollection(
        dataSource,
        target,
        collection,
        { signal, timeoutMs: TRACE_COMMENTS_READ_TIMEOUT_MS }
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
    enabled: Boolean(target.id),
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

  // ISS-5022 cadence state. Held in refs so updating them never re-renders the
  // hook and never re-runs the polling effect (a re-run would tear down and
  // rebuild the timer on every poll).
  const idleStreakRef = useRef(0);
  const lastSignatureRef = useRef<string | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic counter bumped by every scheduling decision. An in-flight poll
  // records the epoch it scheduled under; if anything re-aims the timer while
  // that fetch is outstanding (a mutation reset, a focus reset, a newer poll),
  // the epoch moves and the stale result must not reschedule on top of the newer
  // decision.
  const pollEpochRef = useRef(0);
  // The scheduling loop, kept in a ref so `resetPollCadence` can re-aim a pending
  // timer without depending on the effect's closure identity.
  const scheduleNextPollRef = useRef<((delayMs: number) => void) | null>(null);

  // Reset the cadence to the base interval and re-aim the PENDING timer.
  //
  // Clearing the streak alone is not enough: an already-scheduled backed-off
  // timeout would still be up to the ceiling away, which would push the next poll
  // outside the create/delete marker windows after a local mutation. Every reset
  // path therefore reschedules, it does not just zero a counter.
  const resetPollCadence = useCallback(() => {
    idleStreakRef.current = 0;
    scheduleNextPollRef.current?.(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
  }, []);

  // Re-aim to the base cadence when the reader returns to the surface, so a
  // backed-off thread is immediately live again rather than up to a ceiling-delay
  // stale. Uses TanStack's focus manager rather than a raw `window` listener so
  // the non-DOM (React Native) surface degrades to a no-op instead of throwing —
  // an RN adapter wires no `focusManager`/`onlineManager` bridge, so on that
  // surface this (like the `refetchOnWindowFocus`/`refetchOnReconnect` options
  // above) would be inert and navigation focus the recovery path instead.
  //
  // Gated on `isPollActive` so `active` really is the single on/off switch the
  // docs claim: with the poll off there is no global subscription left running.
  useEffect(() => {
    if (!isPollActive) {
      return;
    }
    return focusManager.subscribe(() => {
      if (focusManager.isFocused()) {
        resetPollCadence();
      }
    });
  }, [resetPollCadence, isPollActive]);

  const queryIdentity = queryKeyString(queryKey);

  // `queryIdentity` is not read in the effect body, but it IS a reset trigger:
  // the effect must re-run (clearing the signature and idle streak) whenever the
  // FULL query identity changes, not just `target.id`. Scope and target type are
  // part of the key too, so a desktop/web data-source swap is a different thread
  // and must not inherit the previous thread's cadence state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger, see above
  useEffect(() => {
    // The poll is hand-rolled (not TanStack's `refetchInterval`), so the `active`
    // gate is applied here too, mirroring the query `enabled` gate above. Note
    // this is the only ON/OFF gate: document visibility widens the interval but
    // never suspends the loop, because a permanently-hidden desktop renderer that
    // never fires `visibilitychange` would otherwise stall forever (see the
    // `active` doc / Sessions parity note).
    if (!(target.id && isPollActive)) {
      return;
    }

    // Disposal is scoped to THIS effect run, deliberately not a shared ref.
    // The effect re-runs (not remounts) when the target changes, so a shared flag
    // would be flipped back to `false` by the new run and would stop guarding the
    // previous run's still-in-flight fetch. That stale fetch would then write the
    // old thread's signature into the new thread's state and, worse, re-aim
    // `pollTimeoutRef` at the OLD target's `refetchTraceComments` — silently
    // stopping the visible thread from polling while the abandoned one continued.
    let disposed = false;
    // Single-flight guard. `refetch()` on a query that is already fetching
    // returns the SAME in-flight promise, so without this every tick would
    // attach another completion handler to it: one slow first load would then be
    // counted once per tick, each extra handler seeing an unchanged signature and
    // incrementing the idle streak, fabricating idleness out of a single result.
    // It also stops a hung request being joined by a fresh one every 2s. Since
    // ISS-5110 a wedged read additionally fails on its own deadline
    // (`TRACE_COMMENTS_READ_TIMEOUT_MS`) instead of holding this guard until it
    // settles, so the guard bounds pile-up and the deadline bounds the wait.
    let pollInFlight = false;
    // A new target is a new thread: start it at the base cadence.
    idleStreakRef.current = 0;
    lastSignatureRef.current = null;

    const currentDelayMs = () =>
      resolveTraceCommentsPollDelayMs({
        idleStreak: idleStreakRef.current,
      });

    const scheduleNextPoll = (delayMs: number) => {
      // ALWAYS clear before setting. This is what makes every caller — the tick
      // itself, a reset after a mutation, a focus event — able to re-aim a
      // pending timer instead of racing a second one alongside it.
      if (pollTimeoutRef.current !== null) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      if (disposed) {
        return;
      }
      pollEpochRef.current += 1;
      pollTimeoutRef.current = setTimeout(runPoll, delayMs);
    };

    function runPoll() {
      pollTimeoutRef.current = null;
      // Schedule the successor BEFORE firing the fetch. An await-then-reschedule
      // loop would park for as long as the request took to settle — up to the
      // read deadline (ISS-5110), and before that deadline existed, forever.
      // Pre-scheduling keeps the loop alive independently of any one request.
      const scheduledDelayMs = currentDelayMs();
      scheduleNextPoll(scheduledDelayMs);
      const scheduledEpoch = pollEpochRef.current;

      // Skip the fetch while one is outstanding, but leave the timer running:
      // the loop must stay alive (that is the anti-stall guarantee) without
      // stacking reads on a slow or hung one.
      if (pollInFlight) {
        return;
      }
      pollInFlight = true;

      refetchTraceComments()
        .then((result) => {
          if (disposed) {
            return;
          }
          // A failed read is NOT evidence the thread is quiet. `refetch()`
          // resolves (rather than rejects) on an HTTP failure, reporting it as
          // `isError` with `data` left at the last-known-good value — so folding
          // an error into the signature comparison would read as "unchanged" and
          // march the cadence toward the ceiling because the endpoint is broken.
          // Leave the streak untouched and let the already-scheduled successor
          // retry at the current cadence.
          if (result.isError) {
            return;
          }
          const signature = traceCommentListSignature(result.data ?? []);
          if (lastSignatureRef.current === signature) {
            idleStreakRef.current += 1;
          } else {
            lastSignatureRef.current = signature;
            idleStreakRef.current = 0;
          }
          // Re-aim if this result changed what the cadence should be, so a remote
          // change discovered during back-off does not leave the next poll a full
          // ceiling away.
          // Only re-aim if nothing else has scheduled since this poll fired. A
          // mutation or focus reset that landed while the fetch was outstanding
          // has already aimed the timer more recently and more accurately;
          // rescheduling from this older decision would push that poll later.
          const nextDelayMs = currentDelayMs();
          if (
            pollEpochRef.current === scheduledEpoch &&
            nextDelayMs !== scheduledDelayMs
          ) {
            scheduleNextPoll(nextDelayMs);
          }
        })
        // Swallowing is safe HERE and only here: the successor timer was already
        // scheduled above, so a rejected read costs one cycle and never parks the
        // loop. It is deliberately not logged — `packages/app` is browser-bundled
        // and the no-client-debug-logging gate applies. Surfacing a persistently
        // failing comments read in the UI is a real gap, tracked in ISS-5110.
        .catch(() => undefined)
        .finally(() => {
          pollInFlight = false;
        });
    }

    scheduleNextPollRef.current = scheduleNextPoll;
    scheduleNextPoll(currentDelayMs());

    return () => {
      disposed = true;
      scheduleNextPollRef.current = null;
      if (pollTimeoutRef.current !== null) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [refetchTraceComments, target.id, isPollActive, queryIdentity]);

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
      // Local activity means the thread is live again: re-aim the next poll to
      // the base interval so it lands inside this create marker's window.
      resetPollCadence();
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
      resetPollCadence();
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
      resetPollCadence();
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
      // Re-aim to the base interval so the confirming poll lands inside the
      // tombstone window above, even if the cadence had backed off to the ceiling.
      resetPollCadence();
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
      deleteMutation.isPending,
    deleteTraceComment,
    jumpToTraceComment,
    replyToTraceComment,
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
