"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  FileCode,
  Filter,
  Loader2,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { CommentChatDialog } from "@/components/engineer/CommentChatDialog";
import {
  type PRComment,
  PRCommentCard,
} from "@/components/engineer/PRCommentCard";
import { useCodexAvailable } from "@/hooks/engineer/use-codex-available";
import { useFeatureSeen } from "@/hooks/engineer/use-feature-seen";
import {
  type CommentDisplayStatus,
  getCommentStatusCounts,
  getCommentStatuses,
  markChatStarted,
  markCommentDismissed,
  resetCommentStatus,
} from "@/lib/engineer/pr-comment-tracker";
import { prCommentsOptions } from "@/lib/engineer/queries/git";

type PRCommentsViewerProps = {
  prNumber: number;
  repoPath: string;
  ticketId: string;
  /** When provided, comment interactions call this callback instead of opening the dialog */
  onCommentSelected?: (
    comment: PRComment,
    replies: PRComment[],
    autoStart: boolean,
    provider?: "claude" | "codex"
  ) => void;
  /** Bump to force re-read of localStorage comment statuses from outside */
  statusRefreshKey?: number;
  /** Called when a comment is dismissed, so the parent can close any open chat */
  onCommentDismissed?: (commentId: string) => void;
  /** Called when "Review with Codex" is selected from a comment card overflow */
  onReviewCodex?: (commentId: string) => void;
};

type FilterType = "all" | "pending" | "resolved";

type CommentThread = {
  root: PRComment;
  replies: PRComment[];
};

/**
 * Group flat comments into threads. Comments with inReplyToId are attached
 * to their parent (matched by databaseId). Orphans become standalone roots.
 * Replies sorted oldest-first; threads sorted newest-first by root.
 */
function buildThreads(comments: PRComment[]): CommentThread[] {
  const byDatabaseId = new Map<number, PRComment>();
  for (const c of comments) {
    if (c.databaseId) {
      byDatabaseId.set(c.databaseId, c);
    }
  }

  const threads = new Map<string, CommentThread>();

  // First pass: identify roots (no inReplyToId)
  for (const c of comments) {
    if (!c.inReplyToId) {
      threads.set(c.id, { root: c, replies: [] });
    }
  }

  // Second pass: attach replies to their parent thread
  for (const c of comments) {
    if (!c.inReplyToId) {
      continue;
    }
    const parent = byDatabaseId.get(c.inReplyToId);
    if (parent && threads.has(parent.id)) {
      threads.get(parent.id)!.replies.push(c);
    } else {
      // Orphan reply — promote to standalone root
      threads.set(c.id, { root: c, replies: [] });
    }
  }

  // Sort replies oldest-first within each thread
  for (const thread of threads.values()) {
    thread.replies.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  // Sort threads newest-first by root
  return Array.from(threads.values()).sort(
    (a, b) =>
      new Date(b.root.createdAt).getTime() -
      new Date(a.root.createdAt).getTime()
  );
}

/**
 * PRCommentsViewer displays all PR comments with filtering and status tracking.
 * Polls for new comments every 30 seconds when visible.
 */
export function PRCommentsViewer({
  prNumber,
  repoPath,
  ticketId,
  onCommentSelected,
  statusRefreshKey = 0,
  onCommentDismissed,
  onReviewCodex,
}: Readonly<PRCommentsViewerProps>) {
  const [filter, setFilter] = useState<FilterType>("pending");
  const [addressingComment, setAddressingComment] = useState<PRComment | null>(
    null
  );
  const [addressingReplies, setAddressingReplies] = useState<PRComment[]>([]);
  const [statusVersion, setStatusVersion] = useState(0);
  const { data: codexData } = useCodexAvailable();
  const { seen: overflowSeen, markSeen: markOverflowSeen } = useFeatureSeen(
    "pr-comment-overflow"
  );

  // Fetch PR comments with polling
  const {
    data: commentsData,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    ...prCommentsOptions(prNumber, repoPath),
    refetchInterval: 30_000, // Poll every 30 seconds
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    staleTime: 10_000, // Consider data stale after 10 seconds
  });

  // Get local status for all comments — re-read from localStorage whenever statusVersion changes
  const commentStatuses = useMemo(() => {
    return getCommentStatuses(prNumber);
    // statusVersion is intentionally included to force re-read after dismiss/reopen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prNumber, statusVersion]);

  // Build threads from flat comments
  const threads = useMemo(() => {
    if (!commentsData?.comments) {
      return [];
    }
    return buildThreads(commentsData.comments);
  }, [commentsData]);

  // Get status counts (only root comments)
  const statusCounts = useMemo(() => {
    if (!threads.length) {
      return { pending: 0, addressed: 0, responded: 0, dismissed: 0 };
    }
    return getCommentStatusCounts(
      prNumber,
      threads.map((t) => t.root.id)
    );
    // statusVersion included so counts update after dismiss/reopen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prNumber, threads, statusVersion]);

  // Filter threads based on selected filter, grouped into inline and general
  const filteredThreads = useMemo(() => {
    const filtered = threads.filter((thread) => {
      const status = commentStatuses[thread.root.id]?.status || "pending";

      if (filter === "all") {
        return true;
      }
      if (filter === "pending") {
        return status === "pending";
      }
      if (filter === "resolved") {
        return (
          status === "addressed" ||
          status === "responded" ||
          status === "dismissed"
        );
      }
      return true;
    });

    return {
      inline: filtered.filter((t) => t.root.path),
      general: filtered.filter((t) => !t.root.path),
    };
  }, [threads, commentStatuses, filter]);

  // Handler for dismissing a comment
  const handleDismiss = (commentId: string) => {
    markCommentDismissed(prNumber, commentId);
    // Force re-computation of statuses by incrementing version
    setStatusVersion((v) => v + 1);
    onCommentDismissed?.(commentId);
  };

  // Handler for reopening a resolved/dismissed comment
  const handleReopen = (commentId: string) => {
    resetCommentStatus(prNumber, commentId);
    // Force re-computation of statuses by incrementing version
    setStatusVersion((v) => v + 1);
  };

  // Handler for opening chat to address a comment
  const handleProposeFix = (
    comment: PRComment,
    replies: PRComment[] = [],
    autoStart = true
  ) => {
    if (autoStart) {
      markChatStarted(prNumber, comment.id);
      setStatusVersion((v) => v + 1);
    }
    if (onCommentSelected) {
      // Callback mode: parent handles the comment chat UI
      onCommentSelected(comment, replies, autoStart);
    } else {
      // Dialog mode: open modal internally
      setAddressingComment(comment);
      setAddressingReplies(replies);
    }
  };

  // Handler for opening Codex chat to address a comment
  const handleProposeFixCodex = (
    comment: PRComment,
    replies: PRComment[] = []
  ) => {
    markChatStarted(prNumber, comment.id);
    setStatusVersion((v) => v + 1);
    if (onCommentSelected) {
      onCommentSelected(comment, replies, true, "codex");
    } else {
      // Dialog mode: open modal same as Claude (CommentChatDialog doesn't support Codex auto-start)
      setAddressingComment(comment);
      setAddressingReplies(replies);
    }
  };

  // Get status for a comment
  const getStatus = (commentId: string): CommentDisplayStatus => {
    const entry = commentStatuses[commentId];
    if (!entry) {
      return "pending";
    }
    if (entry.status === "pending" && entry.chatStarted) {
      return "analyzing";
    }
    return entry.status;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mb-3 size-8 animate-spin" />
        <p className="text-sm">Loading PR comments...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <MessageSquare className="size-6 text-destructive" />
        </div>
        <p className="mb-2 font-medium text-destructive text-sm">
          Failed to load comments
        </p>
        <p className="mb-4 text-muted-foreground text-xs">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button onClick={() => refetch()} size="sm" variant="outline">
          <RefreshCw className="mr-2 size-4" />
          Retry
        </Button>
      </div>
    );
  }

  // Empty state
  if (!threads.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="size-6 text-muted-foreground" />
        </div>
        <p className="mb-1 font-medium text-sm">No comments yet</p>
        <p className="text-muted-foreground text-xs">
          Comments on this PR will appear here
        </p>
      </div>
    );
  }

  const pendingCount = statusCounts.pending;
  const resolvedCount =
    statusCounts.addressed + statusCounts.responded + statusCounts.dismissed;

  return (
    <div className="flex h-full flex-col">
      {/* Header with filter and refresh */}
      <div className="mb-4 flex items-center justify-between">
        {/* Filter buttons */}
        <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
          <button
            className={cn(
              "cursor-pointer rounded-md px-3 py-1 font-medium text-xs transition-colors",
              filter === "all"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setFilter("all")}
          >
            All ({threads.length})
          </button>
          <button
            className={cn(
              "cursor-pointer rounded-md px-3 py-1 font-medium text-xs transition-colors",
              filter === "pending"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setFilter("pending")}
          >
            Pending ({pendingCount})
          </button>
          <button
            className={cn(
              "cursor-pointer rounded-md px-3 py-1 font-medium text-xs transition-colors",
              filter === "resolved"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setFilter("resolved")}
          >
            Resolved ({resolvedCount})
          </button>
        </div>

        {/* Refresh button */}
        <Button
          className="h-8"
          disabled={isFetching}
          onClick={() => refetch()}
          size="sm"
          variant="ghost"
        >
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
        </Button>
      </div>

      {/* Comments list */}
      <div className="flex-1 space-y-3 overflow-y-auto">
        {filteredThreads.inline.length === 0 &&
        filteredThreads.general.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Filter className="mb-2 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground text-sm">
              No {filter === "pending" ? "pending" : "resolved"} comments
            </p>
          </div>
        ) : (
          <>
            {filteredThreads.inline.length > 0 && (
              <CommentSection
                codexAvailable={codexData?.available}
                commentStatuses={commentStatuses}
                getStatus={getStatus}
                icon={<FileCode className="size-3.5" />}
                label="Inline Comments"
                markOverflowSeen={markOverflowSeen}
                onDismiss={handleDismiss}
                onProposeFix={handleProposeFix}
                onProposeFixCodex={handleProposeFixCodex}
                onReopen={handleReopen}
                onReviewCodex={codexData?.available ? onReviewCodex : undefined}
                overflowSeen={overflowSeen}
                threads={filteredThreads.inline}
              />
            )}
            {filteredThreads.general.length > 0 && (
              <CommentSection
                codexAvailable={codexData?.available}
                commentStatuses={commentStatuses}
                getStatus={getStatus}
                icon={<MessageSquare className="size-3.5" />}
                label="General Comments"
                markOverflowSeen={markOverflowSeen}
                onDismiss={handleDismiss}
                onProposeFix={handleProposeFix}
                onProposeFixCodex={handleProposeFixCodex}
                onReopen={handleReopen}
                onReviewCodex={codexData?.available ? onReviewCodex : undefined}
                overflowSeen={overflowSeen}
                threads={filteredThreads.general}
              />
            )}
          </>
        )}
      </div>

      {/* Comment chat dialog - only rendered when not using callback mode */}
      {!onCommentSelected && addressingComment && (
        <CommentChatDialog
          comment={addressingComment}
          onOpenChange={(open) => !open && setAddressingComment(null)}
          onResolved={() => {
            setAddressingComment(null);
            setStatusVersion((v) => v + 1);
            refetch();
          }}
          open={!!addressingComment}
          prNumber={prNumber}
          replies={addressingReplies}
          repoPath={repoPath}
          ticketId={ticketId}
        />
      )}
    </div>
  );
}

/**
 * Renders a labeled group of comment cards (inline or general)
 */
function CommentSection({
  label,
  icon,
  threads,
  commentStatuses,
  codexAvailable,
  overflowSeen,
  markOverflowSeen,
  onReviewCodex,
  getStatus,
  onProposeFix,
  onProposeFixCodex,
  onDismiss,
  onReopen,
}: Readonly<{
  label: string;
  icon: React.ReactNode;
  threads: CommentThread[];
  commentStatuses: Record<string, { commitSha?: string }>;
  codexAvailable?: boolean;
  overflowSeen: boolean;
  markOverflowSeen: () => void;
  onReviewCodex?: (commentId: string) => void;
  getStatus: (id: string) => CommentDisplayStatus;
  onProposeFix: (
    comment: PRComment,
    replies: PRComment[],
    autoStart: boolean
  ) => void;
  onProposeFixCodex: (comment: PRComment, replies: PRComment[]) => void;
  onDismiss: (commentId: string) => void;
  onReopen: (commentId: string) => void;
}>) {
  return (
    <div>
      <div className="mt-1 mb-2 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {label}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="space-y-3">
        {threads.map((thread) => (
          <PRCommentCard
            comment={thread.root}
            commitSha={commentStatuses[thread.root.id]?.commitSha}
            key={thread.root.id}
            markOverflowSeen={markOverflowSeen}
            onDismiss={() => onDismiss(thread.root.id)}
            onProposeFix={() => onProposeFix(thread.root, thread.replies, true)}
            onProposeFixCodex={
              codexAvailable
                ? () => onProposeFixCodex(thread.root, thread.replies)
                : undefined
            }
            onReopen={() => onReopen(thread.root.id)}
            onReviewCodex={
              codexAvailable && onReviewCodex
                ? () => onReviewCodex(thread.root.id)
                : undefined
            }
            onViewChat={() => onProposeFix(thread.root, thread.replies, false)}
            overflowSeen={overflowSeen}
            replies={thread.replies}
            status={getStatus(thread.root.id)}
          />
        ))}
      </div>
    </div>
  );
}
