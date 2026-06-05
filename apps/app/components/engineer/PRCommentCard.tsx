"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { cn } from "@repo/design-system/lib/utils";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  ExternalLink,
  FileCode,
  MessageCircle,
  MessageSquare,
  MoreVertical,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import type { CommentDisplayStatus } from "@/lib/engineer/pr-comment-tracker";
import { getTextContent } from "@/lib/engineer/utils";

/**
 * Format a date as relative time (e.g., "2 hours ago", "3 days ago")
 */
function formatRelativeTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return "just now";
  }
  if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (diffInSeconds < 86_400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diffInSeconds < 604_800) {
    const days = Math.floor(diffInSeconds / 86_400);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (diffInSeconds < 2_592_000) {
    const weeks = Math.floor(diffInSeconds / 604_800);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  const months = Math.floor(diffInSeconds / 2_592_000);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export type PRComment = {
  id: string;
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  isReview: boolean;
  url: string;
  inReplyToId?: number;
};

type PRCommentCardProps = {
  comment: PRComment;
  status: CommentDisplayStatus;
  commitSha?: string;
  replies?: PRComment[];
  isStreaming?: boolean;
  /** Whether this comment's chat is currently visible in the right pane */
  isSelected?: boolean;
  onProposeFix?: () => void;
  onProposeFixCodex?: () => void;
  onDismiss?: () => void;
  onViewChat?: () => void;
  onReopen?: () => void;
  overflowSeen?: boolean;
  markOverflowSeen?: () => void;
};

/**
 * Get status badge styling
 */
function getStatusBadge(status: CommentDisplayStatus, commitSha?: string) {
  switch (status) {
    case "pending":
      return {
        icon: Clock,
        label: "Pending",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      };
    case "analyzing":
      return {
        icon: MessageSquare,
        label: "Analyzing",
        className: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
      };
    case "addressed":
      return {
        icon: Check,
        label: commitSha ? `Addressed (${commitSha.slice(0, 7)})` : "Addressed",
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      };
    case "responded":
      return {
        icon: MessageCircle,
        label: "Responded",
        className: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
      };
    case "dismissed":
      return {
        icon: X,
        label: "Dismissed",
        className: "bg-muted text-muted-foreground",
      };
  }
}

/**
 * Shared markdown component overrides for comment rendering
 */
const markdownComponents = {
  code({
    className,
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"code"> & { className?: string }) {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = getTextContent(children).replace(/\n$/, "");

    if (match) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language={match[1]}
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    if (codeString.includes("\n")) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language="text"
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    return (
      <code
        className="rounded bg-muted-foreground/20 px-1.5 py-0.5 font-mono text-[12px]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  },
};

/**
 * PRCommentCard displays a single PR comment with its status and actions
 */
const TRUNCATE_LENGTH = 200;

export function PRCommentCard({
  comment,
  status,
  commitSha,
  replies = [],
  isStreaming = false,
  isSelected = false,
  onProposeFix,
  onProposeFixCodex,
  onDismiss,
  onViewChat,
  onReopen,
  overflowSeen = true,
  markOverflowSeen,
}: Readonly<PRCommentCardProps>) {
  const [isExpanded, setIsExpanded] = useState(false);
  const statusBadge = getStatusBadge(status, commitSha);
  const StatusIcon = statusBadge.icon;
  const isPending = status === "pending";
  const isResolved =
    status === "addressed" || status === "responded" || status === "dismissed";
  const isLongComment = comment.body.length > TRUNCATE_LENGTH;

  // Format the timestamp
  const timeAgo = formatRelativeTime(new Date(comment.createdAt));

  return (
    <div
      className={cn(
        "group cursor-pointer rounded-lg border bg-card p-4 transition-all duration-200",
        isSelected && "border-l-[3px] border-l-blue-500 bg-blue-500/[0.04]",
        !isSelected && isPending && "hover:border-primary/30 hover:shadow-sm",
        !(isSelected || isPending) && "opacity-75 hover:opacity-100"
      )}
      onClick={onViewChat}
    >
      {/* Header: Author + timestamp, file location below */}
      <div className="mb-2 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {/* Author avatar placeholder */}
            <div className="flex size-6 flex-shrink-0 items-center justify-center rounded-full bg-muted">
              <span className="font-medium text-muted-foreground text-xs">
                {comment.author.charAt(0).toUpperCase()}
              </span>
            </div>

            {/* Author name */}
            <span className="truncate font-medium text-sm">
              @{comment.author}
            </span>
          </div>

          {/* Timestamp */}
          <span className="whitespace-nowrap text-muted-foreground text-xs">
            {timeAgo}
          </span>
        </div>

        {/* File location badge — own row so it never squeezes the author */}
        {comment.path && (
          <div className="pl-8">
            <span className="inline-flex max-w-full items-center gap-1 truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
              <FileCode className="size-3 shrink-0" />
              <span className="truncate">
                {comment.path.split("/").pop()}
                {comment.line ? `:${comment.line}` : ""}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Comment body */}
      <div className="mb-3">
        <div
          className={cn(
            "prose prose-sm dark:prose-invert prose-headings:my-1.5 prose-p:my-1 max-w-none prose-headings:text-sm text-[13px]",
            isLongComment && !isExpanded && "max-h-[6em] overflow-hidden"
          )}
        >
          <ReactMarkdown
            components={markdownComponents}
            remarkPlugins={[remarkGfm]}
          >
            {comment.body}
          </ReactMarkdown>
        </div>
        {isLongComment && (
          <button
            className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="size-3" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="size-3" />
                Show more
              </>
            )}
          </button>
        )}
      </div>

      {/* Replies thread */}
      {replies.length > 0 && (
        <div className="mb-3">
          {/* Divider with reply count */}
          <div className="mb-3 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="font-medium text-muted-foreground text-xs">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Reply list */}
          <div className="space-y-2.5 border-muted border-l-2 pl-4">
            {replies.map((reply) => (
              <div key={reply.id}>
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className="font-medium text-foreground/80 text-xs">
                    @{reply.author}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatRelativeTime(new Date(reply.createdAt))}
                  </span>
                </div>
                <div className="prose prose-sm dark:prose-invert prose-headings:my-1.5 prose-p:my-1 max-w-none prose-headings:text-sm text-[13px] text-foreground/75">
                  <ReactMarkdown
                    components={markdownComponents}
                    remarkPlugins={[remarkGfm]}
                  >
                    {reply.body}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer: Status badge and actions */}
      <div className="flex items-center justify-between gap-2">
        {/* Status badge (icon-only with tooltip) — pulses while streaming */}
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full",
            statusBadge.className,
            isStreaming && "animate-pulse"
          )}
          title={statusBadge.label}
        >
          <StatusIcon className="size-3" />
        </span>

        {/* Action buttons */}
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Pending: Overflow menu + Dismiss */}
          {isPending && (
            <>
              {onDismiss && (
                <Button
                  className="h-7 text-muted-foreground text-xs hover:text-foreground"
                  onClick={onDismiss}
                  size="sm"
                  variant="ghost"
                >
                  Dismiss
                </Button>
              )}
              <PendingOverflowMenu
                comment={comment}
                markOverflowSeen={markOverflowSeen}
                onProposeFix={onProposeFix}
                onProposeFixCodex={onProposeFixCodex}
                overflowSeen={overflowSeen}
              />
            </>
          )}

          {/* Resolved: View + Reopen inline, overflow with View on GitHub */}
          {isResolved && (
            <>
              {onViewChat && status !== "dismissed" && (
                <Button
                  className="h-7 text-xs"
                  onClick={onViewChat}
                  size="sm"
                  variant="ghost"
                >
                  View
                  <ExternalLink className="ml-1 size-3" />
                </Button>
              )}
              {onReopen && (
                <Button
                  className="h-7 text-muted-foreground text-xs hover:text-foreground"
                  onClick={onReopen}
                  size="sm"
                  variant="ghost"
                >
                  Reopen
                </Button>
              )}
              <GitHubOnlyOverflow url={comment.url} />
            </>
          )}

          {/* Analyzing / other states: overflow with View on GitHub */}
          {!(isPending || isResolved) && (
            <GitHubOnlyOverflow url={comment.url} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Overflow menu for pending comment cards — Fix with Claude/Codex, View on GitHub
 */
function PendingOverflowMenu({
  comment,
  overflowSeen,
  markOverflowSeen,
  onProposeFix,
  onProposeFixCodex,
}: Readonly<{
  comment: PRComment;
  overflowSeen: boolean;
  markOverflowSeen?: () => void;
  onProposeFix?: () => void;
  onProposeFixCodex?: () => void;
}>) {
  const hasFixItems = !!(onProposeFix || onProposeFixCodex);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          markOverflowSeen?.();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button className="relative h-7 w-7 p-0" size="sm" variant="ghost">
          <MoreVertical className="size-4" />
          {!overflowSeen && (
            <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onProposeFix && (
          <DropdownMenuItem className="cursor-pointer" onClick={onProposeFix}>
            <Sparkles className="size-4" />
            Fix with Claude
          </DropdownMenuItem>
        )}
        {onProposeFixCodex && (
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={onProposeFixCodex}
          >
            <Cpu className="size-4" />
            Fix with Codex
          </DropdownMenuItem>
        )}
        {hasFixItems && comment.url && <DropdownMenuSeparator />}
        {comment.url && (
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() =>
              globalThis.window?.open(
                comment.url,
                "_blank",
                "noopener,noreferrer"
              )
            }
          >
            <ExternalLink className="size-4" />
            View on GitHub
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Minimal overflow with just "View on GitHub" — used for resolved and analyzing states
 */
function GitHubOnlyOverflow({ url }: Readonly<{ url?: string }>) {
  if (!url) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-7 w-7 p-0" size="sm" variant="ghost">
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() =>
            globalThis.window?.open(url, "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLink className="size-4" />
          View on GitHub
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
