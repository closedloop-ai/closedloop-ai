"use client";

import type {
  TraceComment,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
  TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTraceCommentsDataSource } from "../../data-source/trace-comments-provider";
import type { TraceCommentItem } from "./trace-comments";

export const TRACE_COMMENTS_REFETCH_INTERVAL_MS = 2000;

/**
 * Shared live-read query defaults for trace comments. Web and desktop both opt
 * this target-scoped query into immediate staleness so focus/reconnect events
 * always fetch the lightweight comments payload rather than waiting for the
 * full session or branch detail payload to refresh.
 */
export const traceCommentsLiveQueryOptions = {
  staleTime: 0,
  refetchOnReconnect: "always",
  refetchOnWindowFocus: "always",
} as const;

export const traceCommentKeys = {
  all: ["trace-comments"] as const,
  target: (scope: string, target: TraceCommentTarget) =>
    [...traceCommentKeys.all, scope, target.type, target.id] as const,
};

type UseTraceCommentsOptions = {
  target: TraceCommentTarget;
  /** Consumer-specific row jump implementation, e.g. shared session trace or branch playhead. */
  onJumpToRow: (row: number, flash: boolean) => void;
};

/**
 * Owns persisted trace comments for shared trace surfaces. The query polls the
 * lightweight comments endpoint, including while the window is in the
 * background, so web and desktop see each other's comments without refreshing
 * the full session or branch detail payload.
 */
export function useTraceComments({
  target,
  onJumpToRow,
}: UseTraceCommentsOptions) {
  const dataSource = useTraceCommentsDataSource();
  const queryClient = useQueryClient();
  const [activeAnchor, setActiveAnchor] = useState<TraceTextAnchor | null>(
    null
  );
  const queryKey = traceCommentKeys.target(dataSource.scope, target);

  const commentsQuery = useQuery({
    queryKey,
    queryFn: () => dataSource.list(target),
    enabled: Boolean(target.id),
    ...traceCommentsLiveQueryOptions,
  });
  const refetchTraceComments = commentsQuery.refetch;

  useEffect(() => {
    if (!target.id) {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      refetchTraceComments().catch(() => undefined);
    }, TRACE_COMMENTS_REFETCH_INTERVAL_MS);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [refetchTraceComments, target.id]);

  const comments = useMemo(
    () => (commentsQuery.data ?? []).map(toTraceCommentItem),
    [commentsQuery.data]
  );

  const createMutation = useMutation({
    mutationFn: (draft: TraceCommentDraft) => dataSource.create(target, draft),
    onSuccess: (created) => {
      setActiveAnchor(created.anchor);
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
    }) => dataSource.update(target, commentId, update),
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
    }) => dataSource.reply(target, commentId, draft),
    onSuccess: (updated) => {
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        mergeTraceComments(current, updated)
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (commentId: string) => dataSource.delete(target, commentId),
    onSuccess: (_deleted, commentId) => {
      queryClient.setQueryData<TraceComment[]>(queryKey, (current = []) =>
        removeTraceCommentOrReply(current, commentId)
      );
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

function mergeTraceComments(
  current: readonly TraceComment[],
  created: TraceComment
): TraceComment[] {
  const withoutDuplicate = current.filter((item) => item.id !== created.id);
  return [...withoutDuplicate, created].sort((a, b) => {
    const createdAtDelta =
      traceCommentCreatedAtMs(a) - traceCommentCreatedAtMs(b);
    return createdAtDelta === 0 ? a.id.localeCompare(b.id) : createdAtDelta;
  });
}

function traceCommentCreatedAtMs(comment: TraceComment): number {
  const timestamp = new Date(comment.createdAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function removeTraceCommentOrReply(
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
