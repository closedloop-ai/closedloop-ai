"use client";

import {
  CommentKind,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileCode,
  Loader2,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useReplyToComment,
  useSyncBranchView,
} from "@/hooks/queries/use-branch-view";
import { formatRelativeTime } from "@/lib/date-utils";
import { CommentMarkdown } from "@/lib/markdown";
import type { BranchViewComment } from "../types";

type CommentThread = {
  root: BranchViewComment;
  replies: BranchViewComment[];
};

/**
 * Group flat comments into threads. Comments with inReplyToId are attached
 * to their parent (matched by githubCommentId). Orphans become standalone roots.
 */
function buildThreads(comments: BranchViewComment[]): CommentThread[] {
  const byGithubId = new Map<string, BranchViewComment>();
  for (const c of comments) {
    byGithubId.set(c.githubCommentId, c);
  }

  const threads = new Map<string, CommentThread>();

  // First pass: roots (no inReplyToId)
  for (const c of comments) {
    if (!c.inReplyToId) {
      threads.set(c.githubCommentId, { root: c, replies: [] });
    }
  }

  // Second pass: attach replies to parent thread
  for (const c of comments) {
    if (!c.inReplyToId) {
      continue;
    }
    const parent = byGithubId.get(c.inReplyToId);
    if (parent && threads.has(parent.githubCommentId)) {
      threads.get(parent.githubCommentId)!.replies.push(c);
    } else {
      // Orphan reply -- promote to standalone root
      threads.set(c.githubCommentId, { root: c, replies: [] });
    }
  }

  // Sort replies oldest-first within each thread
  for (const thread of threads.values()) {
    thread.replies.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  // Preserve original comment order (oldest-first by root)
  return Array.from(threads.values()).sort(
    (a, b) =>
      new Date(a.root.createdAt).getTime() -
      new Date(b.root.createdAt).getTime()
  );
}

type BranchPrCommentsSectionProps = {
  comments: BranchViewComment[];
  externalLinkId: string;
  selectedCommentId: string | null;
  onSelectComment: (id: string | null) => void;
};

type CommentFilter = "all" | "pending" | "resolved";

type AvatarSize = "md" | "sm";

function getInitials(author: string): string {
  return author
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function CommentAvatar({
  author,
  authorAvatar,
  authorKind,
  size = "md",
}: {
  author: string;
  authorAvatar?: string | null;
  authorKind?: PrCommentAuthorKind;
  size?: AvatarSize;
}) {
  const isMd = size === "md";
  const box = isMd ? "h-8 w-8" : "h-7 w-7";
  const iconClass = isMd ? "h-4 w-4" : "h-3.5 w-3.5";

  if (authorKind === PrCommentAuthorKind.Bot) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-chart-5/15 text-chart-5",
          box
        )}
      >
        <Bot aria-hidden className={iconClass} />
      </span>
    );
  }

  return (
    <span className={cn("flex shrink-0 overflow-hidden rounded-[8px]", box)}>
      <Avatar className={cn("rounded-none", box)}>
        {authorAvatar ? (
          <AvatarImage
            alt={author}
            className="object-cover"
            src={authorAvatar}
          />
        ) : null}
        <AvatarFallback
          className={cn("rounded-none text-xs", !isMd && "text-[10px]")}
        >
          {getInitials(author)}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}

function isCommentResolved(state: BranchViewComment["state"]): boolean {
  return (
    state === PRReviewCommentState.Addressed ||
    state === PRReviewCommentState.Dismissed
  );
}

function CommentRowActions({
  isReplying,
  onReplyToggle,
  showReply,
}: Readonly<{
  isReplying: boolean;
  onReplyToggle: () => void;
  showReply: boolean;
}>) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {showReply ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              aria-label="Reply"
              className={cn(
                "h-7 w-7 shrink-0 p-0",
                isReplying && "bg-accent text-accent-foreground"
              )}
              onClick={onReplyToggle}
              size="icon"
              variant="ghost"
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Reply</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            className="h-7 w-7 shrink-0 p-0"
            size="icon"
            variant="ghost"
          >
            <Ellipsis className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled>Resolve thread</DropdownMenuItem>
          <DropdownMenuItem disabled>Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InlineReplyComposer({
  draft,
  indent,
  isPending,
  onCancel,
  onChangeDraft,
  onSubmit,
}: {
  draft: string;
  /** Match threaded reply horizontal inset (pl-11). */
  indent?: boolean;
  isPending?: boolean;
  onCancel: () => void;
  onChangeDraft: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className={cn(
        "border-border border-b bg-muted/30 py-3 pr-4",
        indent ? "pl-11" : "pl-4"
      )}
    >
      <Textarea
        className="min-h-[88px] resize-y text-sm"
        disabled={isPending}
        onChange={(e) => onChangeDraft(e.target.value)}
        placeholder="Write a reply…"
        value={draft}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          disabled={isPending}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          disabled={draft.trim().length === 0 || isPending}
          onClick={onSubmit}
          size="sm"
          type="button"
        >
          Reply
        </Button>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  replies,
  isSelected,
  isReplying,
  onReplyToggle,
  onSelect,
}: {
  comment: BranchViewComment;
  replies: BranchViewComment[];
  isSelected: boolean;
  isReplying: boolean;
  onReplyToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-border transition-colors",
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <div className="flex w-full min-w-0 items-start gap-2 px-3 py-3 sm:gap-3 sm:px-4 sm:py-4">
        <button
          className="flex min-w-0 flex-1 gap-3 overflow-hidden text-left outline-none"
          onClick={onSelect}
          type="button"
        >
          <CommentAvatar
            author={comment.author}
            authorAvatar={comment.authorAvatar}
            authorKind={comment.authorKind}
          />
          <div className="flex w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[13px] text-foreground">
                  {comment.author}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatRelativeTime(comment.createdAt)}
                </span>
              </div>
            </div>
            {comment.path ? (
              <div className="flex items-center gap-1">
                <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {comment.path}
                  {comment.line == null ? "" : `:${comment.line}`}
                </span>
              </div>
            ) : null}
            <CommentMarkdown className="text-muted-foreground">
              {comment.body}
            </CommentMarkdown>
          </div>
        </button>
        <CommentRowActions
          isReplying={isReplying}
          onReplyToggle={onReplyToggle}
          showReply={comment.kind !== CommentKind.IssueComment}
        />
      </div>
      {replies.length > 0 ? (
        <>
          <div className="mx-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="font-medium text-muted-foreground text-xs">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-3 border-muted border-l-2 bg-muted/20 px-3 py-3 pb-4 pl-8 sm:px-4 sm:pl-12">
            {replies.map((reply) => (
              <div className="flex items-start gap-2.5" key={reply.id}>
                <CommentAvatar
                  author={reply.author}
                  authorAvatar={reply.authorAvatar}
                  authorKind={reply.authorKind}
                  size="sm"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground text-xs">
                      {reply.author}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatRelativeTime(reply.createdAt)}
                    </span>
                  </div>
                  <CommentMarkdown className="text-muted-foreground text-xs">
                    {reply.body}
                  </CommentMarkdown>
                </div>
              </div>
            ))}
            {comment.kind === CommentKind.IssueComment ? null : (
              <Button
                className="h-7 text-muted-foreground text-xs"
                onClick={onReplyToggle}
                size="sm"
                variant="ghost"
              >
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                Reply
              </Button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function BranchPrCommentsSection({
  comments,
  externalLinkId,
  selectedCommentId,
  onSelectComment,
}: Readonly<BranchPrCommentsSectionProps>) {
  const syncMutation = useSyncBranchView(externalLinkId);
  const replyMutation = useReplyToComment(externalLinkId);
  const [expanded, setExpanded] = useState(true);
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(
    null
  );
  const [replyDraft, setReplyDraft] = useState("");
  const resolvedCount = comments.filter((c) =>
    isCommentResolved(c.state)
  ).length;
  const pendingCount = comments.length - resolvedCount;
  const filteredComments = useMemo((): BranchViewComment[] => {
    if (filter === "all") {
      return comments;
    }
    if (filter === "resolved") {
      return comments.filter((c) => isCommentResolved(c.state));
    }
    return comments.filter((c) => !isCommentResolved(c.state));
  }, [comments, filter]);
  const threads = useMemo(
    () => buildThreads(filteredComments),
    [filteredComments]
  );

  function emptyCommentMessage(): string {
    if (comments.length === 0) {
      return "No comments yet";
    }
    if (filter === "pending") {
      return "No pending comments";
    }
    return "No resolved comments";
  }

  function closeReplyComposer(): void {
    setReplyingToCommentId(null);
    setReplyDraft("");
  }

  function toggleReplyComposer(commentId: string): void {
    if (replyingToCommentId === commentId) {
      closeReplyComposer();
      return;
    }
    setReplyingToCommentId(commentId);
    setReplyDraft("");
  }

  function submitReply(): void {
    if (!replyingToCommentId || replyDraft.trim().length === 0) {
      return;
    }
    const comment = comments.find((c) => c.id === replyingToCommentId);
    if (!comment) {
      return;
    }
    replyMutation.mutate(
      {
        commentGithubId: Number(comment.githubCommentId),
        body: replyDraft.trim(),
      },
      { onSuccess: closeReplyComposer }
    );
  }

  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <section className="flex min-w-0 flex-col">
        <div className="flex flex-col gap-2 border-border border-b px-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:py-0">
          <CollapsibleTrigger asChild>
            <button
              className="flex h-10 min-w-0 shrink-0 cursor-pointer items-center gap-1 text-left outline-none hover:bg-accent/30 sm:h-12 [&[data-state=open]]:bg-transparent"
              type="button"
            >
              <span className="font-semibold text-base text-foreground">
                PR Comments
              </span>
              {expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          </CollapsibleTrigger>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Tabs
              className="w-auto"
              onValueChange={(v) => setFilter(v as CommentFilter)}
              value={filter}
            >
              <TabsList>
                <TabsTrigger
                  className="px-2 text-xs sm:px-3 sm:text-sm"
                  value="all"
                >
                  All ({comments.length})
                </TabsTrigger>
                <TabsTrigger
                  className="px-2 text-xs sm:px-3 sm:text-sm"
                  value="pending"
                >
                  Pending ({pendingCount})
                </TabsTrigger>
                <TabsTrigger
                  className="px-2 text-xs sm:px-3 sm:text-sm"
                  value="resolved"
                >
                  Resolved ({resolvedCount})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Sync comments from GitHub"
                  className="h-8 w-8 shrink-0"
                  disabled={syncMutation.isPending}
                  onClick={() => syncMutation.mutate()}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  {syncMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Sync comments from GitHub</p>
              </TooltipContent>
            </Tooltip>
            <Button
              className="h-8 shrink-0 px-3"
              disabled={pendingCount === 0}
              size="sm"
              type="button"
              variant="secondary"
            >
              <CheckCheck className="mr-1.5 h-4 w-4" />
              Resolve All
            </Button>
          </div>
        </div>
        <CollapsibleContent>
          <div className="border-border border-t">
            {threads.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground text-sm">
                {emptyCommentMessage()}
              </p>
            ) : (
              <ScrollArea className="max-h-[420px]">
                <div className="space-y-3 p-3 sm:p-4">
                  {threads.map((thread) => (
                    <div className="min-w-0" key={thread.root.id}>
                      <CommentRow
                        comment={thread.root}
                        isReplying={replyingToCommentId === thread.root.id}
                        isSelected={selectedCommentId === thread.root.id}
                        onReplyToggle={() =>
                          toggleReplyComposer(thread.root.id)
                        }
                        onSelect={() =>
                          onSelectComment(
                            selectedCommentId === thread.root.id
                              ? null
                              : thread.root.id
                          )
                        }
                        replies={thread.replies}
                      />
                      {replyingToCommentId === thread.root.id ? (
                        <InlineReplyComposer
                          draft={replyDraft}
                          isPending={replyMutation.isPending}
                          onCancel={closeReplyComposer}
                          onChangeDraft={setReplyDraft}
                          onSubmit={submitReply}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
