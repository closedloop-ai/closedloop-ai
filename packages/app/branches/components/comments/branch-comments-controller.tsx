"use client";

import type {
  BranchPageDetail,
  BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { BranchCommentsState } from "@repo/api/src/types/branch";
import {
  type BranchTraceCommentCollectionQuery,
  CommentSurface,
  CommentTargetType,
  type TraceComment,
  type TraceCommentTarget,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { traceCommentKeys } from "@repo/app/shared/trace-comments/trace-comment-query";
import {
  assertTraceCommentMutationResult,
  assertTraceCommentWriteSupported,
  executeTraceCommentRetrySync,
  isTraceCommentWriteSupported,
  type TraceCommentsDataSource,
} from "@repo/app/shared/trace-comments/trace-comments-data-source";
import { useTraceCommentsDataSource } from "@repo/app/shared/trace-comments/trace-comments-provider";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PrCommentMarkdown } from "../pr-comment-markdown";
import {
  BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS,
  BRANCH_COMMENTS_READ_TIMEOUT_MS,
  branchCommentCollectionIdentity,
  everyBranchCommentCollectionFailed,
  groupBranchSessionComments,
  readBranchCommentCollections,
} from "./branch-comments-collection-reader";
import {
  BRANCH_COMMENTS_READ_FAILED,
  type BranchCommentDraftTarget,
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentThread,
  DEFAULT_COMMENTS_WIDTH,
  formatBranchCommentTime,
} from "./branch-comments-model";
import {
  BRANCH_COMMENTS_MAX_WIDTH,
  BRANCH_COMMENTS_MIN_WIDTH,
} from "./branch-comments-rail";
import { BranchCommentsWorkspace } from "./branch-comments-workspace";
import { mapSelectedProviderComments } from "./branch-provider-comment-mapper";

export type BranchCommentsControllerProps = {
  activeTab: BranchCommentsTab;
  composerTarget?: BranchCommentDraftTarget | null;
  detail: BranchPageDetail;
  onClose: () => void;
  onJump: (anchor: TraceTextAnchor) => void;
  open: boolean;
  providerComments?: BranchPrCommentsResponse;
  providerError?: boolean;
  providerLoading?: boolean;
  renderedSessionIds: readonly string[];
  returnFocusRef: RefObject<HTMLElement | null>;
  selectedPullRequestKey?: string | null;
  sessionsCoverageNote?: string | null;
};

/** Exact target-scoped native reads plus selected-PR provider comments. */
export function BranchCommentsController({
  activeTab,
  composerTarget,
  detail,
  onClose,
  onJump,
  open,
  providerComments,
  providerError: providerQueryError = false,
  providerLoading: providerQueryLoading = false,
  renderedSessionIds,
  returnFocusRef,
  selectedPullRequestKey,
  sessionsCoverageNote,
}: BranchCommentsControllerProps) {
  const [width, setWidth] = useState(DEFAULT_COMMENTS_WIDTH);
  const dataSource = useTraceCommentsDataSource();
  const queryClient = useQueryClient();
  const [batchUnsupported, setBatchUnsupported] = useState(false);
  const readBatch = supportsBranchSessionBatch(
    activeTab,
    dataSource,
    batchUnsupported
  );
  const collections = useMemo(
    () =>
      commentCollections(
        detail.id,
        activeTab,
        activeTab === BranchCommentsTab.Sessions ? renderedSessionIds : []
      ),
    [activeTab, detail.id, renderedSessionIds]
  );
  const nativeQuery = useQuery({
    queryKey: [
      ...traceCommentKeys.all,
      "branch-workspace",
      dataSource.scope,
      activeTab,
      ...branchWorkspaceQueryIdentity(readBatch, detail.id, collections),
    ],
    // ISS-5110: the read carries this query's own cancellation plus this
    // surface's read deadline, so a wedged workspace read fails instead of
    // holding the transport open.
    //
    // A fan-out where NOTHING came back is reported as a query failure rather
    // than a successful list of empty results (whitlockk review): the surface has no
    // poll, so without an error state there is no retry, no recovery, and no
    // honest signal that the list is unavailable rather than empty. Partial
    // success stays partial and keeps its peers.
    queryFn: async ({ signal }) => {
      if (readBatch && dataSource.listBranchSessions) {
        const comments = await dataSource.listBranchSessions(detail.id, {
          signal,
          timeoutMs: BRANCH_COMMENTS_READ_TIMEOUT_MS,
        });
        if (comments !== null) {
          return groupBranchSessionComments(detail.id, comments);
        }
        setBatchUnsupported(true);
      }
      const results = await readBranchCommentCollections(
        dataSource,
        collections,
        { signal, timeoutMs: BRANCH_COMMENTS_READ_TIMEOUT_MS }
      );
      if (everyBranchCommentCollectionFailed(results)) {
        throw results[0]?.error ?? new Error(BRANCH_COMMENTS_READ_FAILED);
      }
      return results;
    },
    // The recovery policy for that failure: re-attempt only while the query is
    // errored, so a healthy workspace still runs no background traffic.
    refetchInterval: (query) =>
      query.state.status === "error"
        ? BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS
        : false,
    staleTime: 0,
    // ISS-5976 (whitlockk review): this query opts OUT of the shared client's
    // focus/reconnect refetch defaults, at its own construction site, as that
    // policy requires. `staleTime: 0` above is deliberate — a reopened rail must
    // re-read rather than serve a cached list — but it also means this query is
    // ALWAYS stale, so it is the one shape the defaults' `staleTime` bound does
    // not cover: it would refetch on EVERY focus and reconnect, not once a
    // minute. That is not one request but a whole fan-out — one read per
    // collection, issued in chunks of `BRANCH_COMMENTS_READ_CONCURRENCY` — so
    // the cost scales with the number of sessions on the branch. The rail's
    // freshness model is mount/open plus the errored-only `refetchInterval`
    // above, neither of which needs a focus trigger; the session rail reaches
    // the opposite conclusion for a SINGLE-target read and opts in explicitly
    // via `traceCommentsLiveQueryOptions`, which is why neither inherits.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: open,
  });
  useBranchCommentMembershipRefresh({
    branchId: detail.id,
    sessionIds: detail.sessionIds,
    renderedSessionIds,
    open,
    readBatch,
    isFetching: nativeQuery.isFetching,
    refetch: nativeQuery.refetch,
  });
  const nativeResults = nativeQuery.data ?? [];
  const nativeComments = nativeResults.flatMap((result) =>
    result.read.comments.map((comment) =>
      mapNativeThread(
        comment,
        result.collection.collectionQuery,
        canRetrySyncFor(dataSource, comment, result.collection.collectionQuery)
      )
    )
  );
  const providerView =
    activeTab === BranchCommentsTab.Details
      ? mapSelectedProviderComments(
          providerComments,
          detail.id,
          selectedPullRequestKey
        )
      : null;
  const comments = [...nativeComments, ...(providerView?.threads ?? [])];
  const providerMatches = providerView !== null;
  const providerLoading = Boolean(
    activeTab === BranchCommentsTab.Details &&
      selectedPullRequestKey &&
      providerQueryLoading &&
      !providerComments
  );
  const providerError = Boolean(
    activeTab === BranchCommentsTab.Details &&
      (providerQueryError ||
        (providerComments && selectedPullRequestKey && !providerMatches) ||
        (providerMatches &&
          (providerComments?.state === BranchCommentsState.ProviderError ||
            providerComments?.state === BranchCommentsState.ForbiddenMismatch ||
            providerComments?.state === BranchCommentsState.UnsyncedUnknown)))
  );
  // `isError` is part of this, not just the per-target errors: a fan-out that
  // failed outright now rejects, so its results are GONE from `data` rather than
  // present-and-errored. Reading incompleteness off the results alone would let
  // a failed read render as a settled empty list (ISS-5110, whitlockk review).
  const nativeIncomplete =
    nativeQuery.isError ||
    nativeResults.some(
      (result) => result.error !== null || result.read.rejectedCount > 0
    );
  const nativeCoverageNote = nativeCollectionDisclosure(
    activeTab,
    nativeIncomplete
  );
  const coverageNote = joinCoverageNotes(
    activeTab === BranchCommentsTab.Sessions ? sessionsCoverageNote : null,
    nativeCoverageNote,
    providerLoading && comments.length > 0
      ? "GitHub comments are still loading."
      : null,
    providerError && comments.length > 0
      ? "GitHub comments are unavailable."
      : null
  );
  // The former "every result carries an error" clause is gone with the throw
  // above: a fan-out in that state no longer resolves, so it reaches this as
  // `isError` (folded into `nativeIncomplete`) instead.
  const allSourcesUnavailable =
    comments.length === 0 && (providerError || nativeIncomplete);
  const initialLoading =
    comments.length === 0 && (providerLoading || nativeQuery.isLoading);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: traceCommentKeys.all,
    });
  /*
   * ISS-10383: the recovery door. UNDEFINED when the source cannot un-abandon
   * anything — since ISS-10382 the cloud HTTP source CAN, so what is left here
   * is a version-skewed desktop bridge — and withheld per ROW by
   * `canRetrySyncFor`, which is the half a source-level gate gets wrong here.
   *
   * It CATCHES, unlike this surface's other writes, and deliberately: a composer
   * write announces its own failure by reopening with the draft intact, while a
   * rejected retry changes nothing on screen — so without this the refusal, the
   * failure and a success are one picture. Not a mutation, so the shared client's
   * default `mutations.onError` cannot reach it; this is the "catch to suppress
   * an unhandled rejection" `packages/app/AGENTS.md` allows, in the Sessions
   * rail's wording so one failure reads the same on both surfaces.
   */
  const retrySync = dataSource.retrySync
    ? async (
        threadId: string,
        target: TraceCommentTarget,
        collectionQuery?: BranchTraceCommentCollectionQuery
      ) => {
        // `rePended` so the toast means ONE thing: the re-pend did not happen.
        // With `refresh()` inside the same `try` and no such flag, a re-pend
        // that SUCCEEDED and then threw on the refetch told the author "could
        // not retry", and they clicked again on a row already back in the queue
        // (marisolashgrove review). Moving the await out of the `try` instead
        // would fix the wording and reopen the rejection: the card floats this
        // promise rather than awaiting it, so an uncaught refetch failure
        // becomes the unhandled rejection this block exists to absorb.
        let rePended = false;
        try {
          assertTraceCommentWriteSupported(dataSource, target, collectionQuery);
          await executeTraceCommentRetrySync(
            dataSource,
            target,
            threadId,
            collectionQuery
          );
          rePended = true;
          await refresh();
        } catch {
          if (!rePended) {
            toast.error("Could not retry this comment. Please try again.");
          }
        }
      }
    : undefined;

  return (
    <BranchCommentsWorkspace
      activeTab={activeTab}
      branchId={detail.id}
      comments={comments}
      composerTarget={composerTarget}
      coverageNote={coverageNote}
      hasError={allSourcesUnavailable}
      isLoading={initialLoading}
      onClose={onClose}
      onCreate={async ({ anchor, body, collectionQuery, target }) => {
        assertTraceCommentWriteSupported(dataSource, target, collectionQuery);
        assertTraceCommentMutationResult(
          await dataSource.create(
            target,
            { anchor: anchor.trace, body },
            collectionQuery
          ),
          target,
          collectionQuery
        );
        await refresh();
      }}
      onDeleteReply={async (replyId, target, collectionQuery) => {
        assertTraceCommentWriteSupported(dataSource, target, collectionQuery);
        await dataSource.delete(target, replyId, collectionQuery);
        await refresh();
      }}
      onDeleteThread={async (threadId, target, collectionQuery) => {
        assertTraceCommentWriteSupported(dataSource, target, collectionQuery);
        await dataSource.delete(target, threadId, collectionQuery);
        await refresh();
      }}
      onEditRoot={async (threadId, target, collectionQuery, body) => {
        assertTraceCommentWriteSupported(dataSource, target, collectionQuery);
        assertTraceCommentMutationResult(
          await dataSource.update(target, threadId, { body }, collectionQuery),
          target,
          collectionQuery
        );
        await refresh();
      }}
      onJump={(anchor) => onJump(anchor.trace)}
      onReply={async (threadId, target, collectionQuery, body) => {
        assertTraceCommentWriteSupported(dataSource, target, collectionQuery);
        assertTraceCommentMutationResult(
          await dataSource.reply(target, threadId, { body }, collectionQuery),
          target,
          collectionQuery
        );
        await refresh();
      }}
      onRetrySync={retrySync}
      onWidthChange={(nextWidth) =>
        setWidth(
          Math.min(MAX_COMMENTS_WIDTH, Math.max(MIN_COMMENTS_WIDTH, nextWidth))
        )
      }
      open={open}
      providerAvailability={providerView?.availability}
      railId="branch-comments-workspace"
      readFailed={nativeQuery.isError}
      renderBody={(body, thread) =>
        thread.source === BranchCommentSource.Provider ? (
          <PrCommentMarkdown className="text-sm" text={body} />
        ) : (
          body
        )
      }
      renderedSessionIds={renderedSessionIds}
      returnFocusRef={returnFocusRef}
      selectedPullRequestKey={selectedPullRequestKey}
      width={width}
    />
  );
}
function commentCollections(
  branchId: string,
  activeTab: BranchCommentsTab,
  sessionIds: readonly string[]
) {
  const branchCollection =
    activeTab === BranchCommentsTab.Details
      ? {
          target: { type: CommentTargetType.Branch, id: branchId },
          collectionQuery: { surface: CommentSurface.BranchDetail },
        }
      : {
          target: { type: CommentTargetType.Branch, id: branchId },
          collectionQuery: { surface: CommentSurface.BranchTimeline },
        };
  return [
    branchCollection,
    ...sessionIds.map((id) => ({
      target: { type: CommentTargetType.Session, id },
      collectionQuery: undefined,
    })),
  ] satisfies readonly {
    target: { type: "branch" | "session"; id: string };
    collectionQuery?: BranchTraceCommentCollectionQuery;
  }[];
}

function mapNativeThread(
  comment: TraceComment,
  collectionQuery: BranchTraceCommentCollectionQuery | undefined,
  canRetrySync: boolean
): BranchCommentThread {
  const isTimeline =
    comment.target.type === CommentTargetType.Session ||
    collectionQuery?.surface === CommentSurface.BranchTimeline;
  return {
    id: comment.id,
    source: BranchCommentSource.Platform,
    tab: isTimeline ? BranchCommentsTab.Sessions : BranchCommentsTab.Details,
    target: comment.target,
    collectionQuery,
    anchor: comment.anchor
      ? {
          id: `${comment.anchor.traceId}:${comment.anchor.turnId}:${comment.anchor.row}:${comment.anchor.startOffset}:${comment.anchor.endOffset}`,
          label: comment.anchor.selectedText,
          trace: comment.anchor,
        }
      : null,
    author: {
      id: comment.authorId,
      name: comment.authorName ?? "Unknown author",
      avatarUrl: comment.authorAvatarUrl,
    },
    body: comment.body,
    canDeleteThread: comment.canDelete,
    canEditRoot: comment.canEdit,
    canReply: true,
    createdAtLabel: formatBranchCommentTime(comment.createdAt),
    canRetrySync,
    // ISS-10383: the omission is CARRIED, not defaulted to `false`, so this
    // mapper reshapes nothing the port said.
    ...(comment.syncAbandoned === undefined
      ? {}
      : { syncAbandoned: comment.syncAbandoned }),
    replies: (comment.replies ?? []).map((reply) => ({
      id: reply.id,
      body: reply.body,
      canDelete: reply.canDelete,
      createdAtLabel: formatBranchCommentTime(reply.createdAt),
      author: {
        id: reply.authorId,
        name: reply.authorName ?? "Unknown author",
        avatarUrl: reply.authorAvatarUrl,
      },
    })),
  };
}

/**
 * ISS-10383: whether this exact row can be re-pended, asked where the source is.
 *
 * TWO questions, and the Sessions rail only ever has to ask the first. A
 * Branch-timeline row needs `capabilities.branchTimelineWrites` on top of
 * `retrySync`, and on desktop those are independent bridge fields — so a skewed
 * shell answers yes to one and no to the other.
 */
function canRetrySyncFor(
  dataSource: TraceCommentsDataSource,
  comment: TraceComment,
  collectionQuery?: BranchTraceCommentCollectionQuery
): boolean {
  return (
    Boolean(dataSource.retrySync) &&
    // ISS-10382: and the viewer must be the AUTHOR. The server 403s anyone else,
    // and since the cloud began serving `syncAbandoned` to every viewer of the
    // thread the desktop queue's implicit "these are my own rows" no longer
    // holds. `canEdit` is the same authorship the server computes.
    comment.canEdit &&
    isTraceCommentWriteSupported(dataSource, comment.target, collectionQuery)
  );
}

function joinCoverageNotes(
  ...notes: readonly (string | null | undefined)[]
): string | null {
  const present = notes.filter((note): note is string => Boolean(note));
  return present.length > 0 ? present.join(" ") : null;
}

function nativeCollectionDisclosure(
  activeTab: BranchCommentsTab,
  incomplete: boolean
): string | null {
  if (!incomplete) {
    return null;
  }
  if (activeTab === BranchCommentsTab.Sessions) {
    return "Some rendered Session comments aren't available in this view.";
  }
  return "Some Branch comments aren't available in this view.";
}

const MIN_COMMENTS_WIDTH = BRANCH_COMMENTS_MIN_WIDTH;
const MAX_COMMENTS_WIDTH = BRANCH_COMMENTS_MAX_WIDTH;

function supportsBranchSessionBatch(
  activeTab: BranchCommentsTab,
  dataSource: TraceCommentsDataSource,
  batchUnsupported: boolean
): boolean {
  return (
    activeTab === BranchCommentsTab.Sessions &&
    dataSource.listBranchSessions !== undefined &&
    !batchUnsupported
  );
}

function branchWorkspaceQueryIdentity(
  readBatch: boolean,
  branchId: string,
  collections: Parameters<typeof readBranchCommentCollections>[1]
): string[] {
  return readBatch
    ? [branchId]
    : collections.map(branchCommentCollectionIdentity);
}

function useBranchCommentMembershipRefresh({
  branchId,
  sessionIds,
  renderedSessionIds,
  open,
  readBatch,
  isFetching,
  refetch,
}: {
  branchId: string;
  sessionIds: readonly string[];
  renderedSessionIds: readonly string[];
  open: boolean;
  readBatch: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}) {
  // Detail already names the initial membership before the trace hydrates.
  // Union with rendered IDs also catches a live trace arriving before detail.
  const membership = JSON.stringify(
    [...new Set([...(sessionIds ?? []), ...renderedSessionIds])].sort()
  );
  const observed = useRef({ branchId, membership });
  useEffect(() => {
    if (!(open && readBatch) || observed.current.branchId !== branchId) {
      observed.current = { branchId, membership };
      return;
    }
    // Remember changes during a request until it settles, then read again.
    if (isFetching || observed.current.membership === membership) {
      return;
    }
    observed.current = { branchId, membership };
    refetch();
  }, [branchId, membership, open, readBatch, isFetching, refetch]);
}
