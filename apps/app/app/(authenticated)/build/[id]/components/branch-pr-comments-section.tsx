"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
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
import { cn } from "@repo/design-system/lib/utils";
import {
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileCode,
  MessageSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/date-utils";
import type { StubPrComment, StubPrCommentAuthorKind } from "../types";

type BranchPrCommentsSectionProps = {
  comments: StubPrComment[];
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
  authorAvatar?: string;
  authorKind?: StubPrCommentAuthorKind;
  size?: AvatarSize;
}) {
  const isMd = size === "md";
  const box = isMd ? "h-8 w-8" : "h-7 w-7";
  const iconClass = isMd ? "h-4 w-4" : "h-3.5 w-3.5";

  if (authorKind === "bot") {
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

function StatusBadge({ isResolved }: { isResolved: boolean }) {
  return (
    <Badge className="shrink-0 text-[11px]" variant="secondary">
      {isResolved ? "Resolved" : "Pending"}
    </Badge>
  );
}

function CommentRowActions({
  isReplying,
  onReplyToggle,
}: Readonly<{
  isReplying: boolean;
  onReplyToggle: () => void;
}>) {
  return (
    <div className="flex shrink-0 items-center gap-1">
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
          <DropdownMenuItem>Resolve thread</DropdownMenuItem>
          <DropdownMenuItem>Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Threaded reply row: same interactions as top-level (select, reply, overflow). */
function ReplyRow({
  reply,
  isSelected,
  isReplying,
  onReplyToggle,
  onSelect,
}: {
  reply: StubPrComment;
  isSelected: boolean;
  isReplying: boolean;
  onReplyToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-start gap-3 border-border border-b pt-3 pr-4 pb-4 pl-11 transition-colors",
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <button
        className="flex min-w-0 flex-1 gap-3 text-left outline-none"
        onClick={onSelect}
        type="button"
      >
        <CommentAvatar
          author={reply.author}
          authorAvatar={reply.authorAvatar}
          authorKind={reply.authorKind}
          size="sm"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[13px] text-foreground">
              {reply.author}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatRelativeTime(reply.createdAt)}
            </span>
            <StatusBadge isResolved={reply.isResolved} />
          </div>
          <p className="text-[13px] text-muted-foreground leading-[1.5]">
            {reply.body}
          </p>
        </div>
      </button>
      <CommentRowActions
        isReplying={isReplying}
        onReplyToggle={onReplyToggle}
      />
    </div>
  );
}

function InlineReplyComposer({
  draft,
  indent,
  onCancel,
  onChangeDraft,
  onSubmit,
}: {
  draft: string;
  /** Match threaded reply horizontal inset (pl-11). */
  indent?: boolean;
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
        onChange={(e) => onChangeDraft(e.target.value)}
        placeholder="Write a reply…"
        value={draft}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
        <Button
          disabled={draft.trim().length === 0}
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
  isSelected,
  isReplying,
  onReplyToggle,
  onSelect,
}: {
  comment: StubPrComment;
  isSelected: boolean;
  isReplying: boolean;
  onReplyToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-start gap-3 border-border border-b px-4 py-4 transition-colors",
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <button
        className="flex min-w-0 flex-1 gap-3 text-left outline-none"
        onClick={onSelect}
        type="button"
      >
        <CommentAvatar
          author={comment.author}
          authorAvatar={comment.authorAvatar}
          authorKind={comment.authorKind}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[13px] text-foreground">
                {comment.author}
              </span>
              <span className="text-muted-foreground text-xs">
                {formatRelativeTime(comment.createdAt)}
              </span>
              <StatusBadge isResolved={comment.isResolved} />
            </div>
          </div>
          {comment.path ? (
            <div className="flex items-center gap-1">
              <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-muted-foreground text-xs">
                {comment.path}
                {comment.line != null ? `:${comment.line}` : ""}
              </span>
            </div>
          ) : null}
          <p className="text-[13px] text-muted-foreground leading-[1.5]">
            {comment.body}
          </p>
        </div>
      </button>
      <CommentRowActions
        isReplying={isReplying}
        onReplyToggle={onReplyToggle}
      />
    </div>
  );
}

export function BranchPrCommentsSection({
  comments,
  selectedCommentId,
  onSelectComment,
}: Readonly<BranchPrCommentsSectionProps>) {
  const [expanded, setExpanded] = useState(true);
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(
    null
  );
  const [replyDraft, setReplyDraft] = useState("");
  const resolvedCount = comments.filter((c) => c.isResolved).length;
  const pendingCount = comments.length - resolvedCount;
  const filteredComments = useMemo((): StubPrComment[] => {
    if (filter === "all") {
      return comments;
    }
    if (filter === "resolved") {
      return comments.filter((c) => c.isResolved);
    }
    return comments.filter((c) => !c.isResolved);
  }, [comments, filter]);

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

  function submitStubReply(): void {
    closeReplyComposer();
  }

  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <section className="flex flex-col">
        <div className="flex items-center justify-between gap-3 border-border border-b px-4 py-3">
          <CollapsibleTrigger asChild>
            <button
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md text-left outline-none hover:bg-accent/30 [&[data-state=open]]:bg-transparent"
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
          <div className="flex shrink-0 items-center gap-3">
            <Tabs
              className="w-auto"
              onValueChange={(v) => setFilter(v as CommentFilter)}
              value={filter}
            >
              <TabsList>
                <TabsTrigger className="px-3" value="all">
                  All ({comments.length})
                </TabsTrigger>
                <TabsTrigger className="px-3" value="pending">
                  Pending ({pendingCount})
                </TabsTrigger>
                <TabsTrigger className="px-3" value="resolved">
                  Resolved ({resolvedCount})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              className="shrink-0"
              disabled={pendingCount === 0}
              type="button"
            >
              <CheckCheck className="mr-1.5 h-4 w-4" />
              Resolve All
            </Button>
          </div>
        </div>
        <CollapsibleContent>
          <div className="border-border border-t">
            {filteredComments.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground text-sm">
                {emptyCommentMessage()}
              </p>
            ) : (
              <ScrollArea className="max-h-[360px]">
                <div className="flex flex-col">
                  {filteredComments.map((comment) => (
                    <div key={comment.id}>
                      <CommentRow
                        comment={comment}
                        isReplying={replyingToCommentId === comment.id}
                        isSelected={selectedCommentId === comment.id}
                        onReplyToggle={() => toggleReplyComposer(comment.id)}
                        onSelect={() =>
                          onSelectComment(
                            selectedCommentId === comment.id ? null : comment.id
                          )
                        }
                      />
                      {replyingToCommentId === comment.id ? (
                        <InlineReplyComposer
                          draft={replyDraft}
                          onCancel={closeReplyComposer}
                          onChangeDraft={setReplyDraft}
                          onSubmit={submitStubReply}
                        />
                      ) : null}
                      {comment.replies.map((reply) => (
                        <div key={reply.id}>
                          <ReplyRow
                            isReplying={replyingToCommentId === reply.id}
                            isSelected={selectedCommentId === reply.id}
                            onReplyToggle={() => toggleReplyComposer(reply.id)}
                            onSelect={() =>
                              onSelectComment(
                                selectedCommentId === reply.id ? null : reply.id
                              )
                            }
                            reply={reply}
                          />
                          {replyingToCommentId === reply.id ? (
                            <InlineReplyComposer
                              draft={replyDraft}
                              indent
                              onCancel={closeReplyComposer}
                              onChangeDraft={setReplyDraft}
                              onSubmit={submitStubReply}
                            />
                          ) : null}
                        </div>
                      ))}
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
