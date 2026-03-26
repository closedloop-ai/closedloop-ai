"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle,
  FileText,
  Loader2,
  Maximize2,
  RefreshCw,
} from "lucide-react";
import Image from "next/image";
import { type ReactNode, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { symphonyPlanOptions } from "@/lib/engineer/queries/symphony";
import { getTextContent } from "@/lib/engineer/utils";

type PlanViewerProps = {
  ticketId: string;
  repoPath: string;
  /** Optional action to render when plan is ready (e.g., Accept button) */
  renderAction?: () => ReactNode;
  /** Compact mode for embedded views */
  compact?: boolean;
};

/**
 * PlanViewer component displays the Symphony implementation plan.
 * Polls for plan.json availability and renders the markdown content.
 */
export function PlanViewer({
  ticketId,
  repoPath,
  renderAction,
  compact = false,
}: Readonly<PlanViewerProps>) {
  const [isExpanded, setIsExpanded] = useState(false);

  const {
    data: plan,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...symphonyPlanOptions(ticketId, repoPath),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.planExists) {
        return false;
      }
      return 5000;
    },
    retry: false,
  });

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-sm">Loading plan...</p>
        </div>
      </div>
    );
  }

  // Plan not ready yet - show waiting state with optional log viewer
  if (!plan?.planExists) {
    return (
      <div className="flex h-full flex-col">
        {/* Waiting message */}
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
            <FileText className="size-8 opacity-50" />
            <div>
              <p className="font-medium text-sm">Waiting for plan...</p>
              <p className="mt-1 text-xs opacity-70">
                Closedloop.dev is analyzing the ticket
              </p>
            </div>
            <Button
              className="mt-2 gap-2"
              onClick={() => refetch()}
              size="sm"
              variant="outline"
            >
              <RefreshCw className="size-3" />
              Check Now
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error || plan?.error) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="flex flex-col items-center gap-3 text-center text-destructive">
          <p className="font-medium text-sm">Failed to load plan</p>
          <p className="text-xs opacity-70">
            {plan?.error ||
              (error instanceof Error ? error.message : "Unknown error")}
          </p>
          <Button
            className="mt-2 gap-2"
            onClick={() => refetch()}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-3" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Plan available - render it
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      {!compact && (
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h3 className="flex items-center gap-2 font-medium text-sm">
            <FileText className="size-4" />
            Implementation Plan
          </h3>
          <Button
            className="h-7 w-7 p-0"
            onClick={() => setIsExpanded(true)}
            size="sm"
            title="Expand plan"
            variant="ghost"
          >
            <Maximize2 className="size-3" />
          </Button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-auto">
        <ReactMarkdown
          components={buildPlanMarkdownComponents(
            ticketId,
            repoPath,
            "compact"
          )}
          remarkPlugins={[remarkGfm]}
        >
          {plan.content || "No content available"}
        </ReactMarkdown>
      </div>

      {/* Action slot - only rendered when plan exists */}
      {renderAction && (
        <div className="mt-4 shrink-0 border-t pt-4">{renderAction()}</div>
      )}

      {/* Expanded plan dialog */}
      <Dialog onOpenChange={setIsExpanded} open={isExpanded}>
        <DialogContent className="flex h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] flex-col p-0 lg:max-w-[85vw] xl:max-w-[80vw]">
          <DialogTitle className="sr-only">Implementation Plan</DialogTitle>
          <div className="flex shrink-0 items-center justify-between border-b p-4">
            <h2 className="flex items-center gap-2 font-semibold text-lg">
              <FileText className="size-5" />
              Implementation Plan
            </h2>
          </div>
          <div className="prose prose-sm dark:prose-invert max-w-none flex-1 overflow-auto p-6">
            <ReactMarkdown
              components={buildPlanMarkdownComponents(
                ticketId,
                repoPath,
                "expanded"
              )}
              remarkPlugins={[remarkGfm]}
            >
              {plan.content || "No content available"}
            </ReactMarkdown>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Transform local file paths to API URLs for attachments
 * Input: /Users/.../repoName-ticketId/.claude/work/attachments/image-1.png
 * Output: /api/engineer/symphony/attachments/ticketId/image-1.png?repo=~/Source/repoName
 */
function transformImageSrc(
  src: string,
  ticketId: string,
  repoPath: string
): string {
  // Match full path (.claude/work/attachments/..., .closedloop-ai/work/attachments/...) or relative path (attachments/...)
  const attachmentsMatch =
    /(?:\.claude\/work\/|\.closedloop-ai\/work\/)?attachments\/(.+)$/.exec(src);
  if (attachmentsMatch) {
    const filename = attachmentsMatch[1];
    return `/api/engineer/symphony/attachments/${encodeURIComponent(ticketId)}/${encodeURIComponent(filename)}?repo=${encodeURIComponent(repoPath)}`;
  }
  return src;
}

/**
 * Build ReactMarkdown component overrides for plan rendering.
 * The `img` component needs ticketId/repoPath to resolve attachment URLs,
 * so this is a factory rather than a static object.
 */
function buildPlanMarkdownComponents(
  ticketId: string,
  repoPath: string,
  variant: "compact" | "expanded"
): Components {
  const isCompact = variant === "compact";
  return {
    h1: ({ children }) => (
      <h1
        className={
          isCompact
            ? "mt-4 mb-2 border-b pb-1 font-bold text-lg first:mt-0"
            : "mt-6 mb-3 border-b pb-2 font-bold text-xl first:mt-0"
        }
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className={
          isCompact
            ? "mt-4 mb-2 font-semibold text-base"
            : "mt-5 mb-2 font-semibold text-lg"
        }
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3
        className={
          isCompact
            ? "mt-3 mb-1 font-semibold text-sm"
            : "mt-4 mb-2 font-semibold text-base"
        }
      >
        {children}
      </h3>
    ),
    table: ({ children }) => (
      <div
        className={isCompact ? "my-3 overflow-x-auto" : "my-4 overflow-x-auto"}
      >
        <table
          className={
            isCompact
              ? "w-full border-collapse text-xs"
              : "w-full border-collapse text-sm"
          }
        >
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
    th: ({ children }) => (
      <th
        className={
          isCompact
            ? "border border-border px-2 py-1.5 text-left font-semibold"
            : "border border-border px-3 py-2 text-left font-semibold"
        }
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className={
          isCompact
            ? "border border-border px-2 py-1.5"
            : "border border-border px-3 py-2"
        }
      >
        {children}
      </td>
    ),
    tr: ({ children }) => <tr className="even:bg-muted/30">{children}</tr>,
    img: ({ src, alt }) => {
      const imgSrc =
        typeof src === "string"
          ? transformImageSrc(src, ticketId, repoPath)
          : "";
      return (
        <Image
          alt={alt || ""}
          className={
            isCompact
              ? "my-3 h-auto max-w-full rounded-lg"
              : "my-4 h-auto max-w-full rounded-lg"
          }
          height={600}
          src={imgSrc}
          unoptimized
          width={800}
        />
      );
    },
    code: ({ className, children, ...props }) => {
      const isInline = !className;
      if (isInline) {
        return (
          <code
            className={
              isCompact
                ? "rounded bg-muted px-1 py-0.5 text-xs"
                : "rounded bg-muted px-1.5 py-0.5 text-sm"
            }
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre
        className={
          isCompact
            ? "overflow-x-auto rounded-lg bg-muted p-2 text-xs"
            : "overflow-x-auto rounded-lg bg-muted p-3 text-sm"
        }
      >
        {children}
      </pre>
    ),
    ul: ({ children }) => (
      <ul
        className={
          isCompact
            ? "list-disc space-y-0.5 pl-4 text-sm"
            : "list-disc space-y-1 pl-5"
        }
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        className={
          isCompact
            ? "list-decimal space-y-0.5 pl-4 text-sm"
            : "list-decimal space-y-1 pl-5"
        }
      >
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => {
      const content = getTextContent(children);
      if (content.startsWith("[ ]")) {
        return (
          <li
            className={
              isCompact
                ? "flex items-start gap-2 text-sm"
                : "flex items-start gap-2"
            }
            {...props}
          >
            <span
              className={
                isCompact
                  ? "mt-0.5 size-3.5 shrink-0 rounded border"
                  : "mt-0.5 size-4 shrink-0 rounded border"
              }
            />
            <span>{content.slice(4)}</span>
          </li>
        );
      }
      if (content.startsWith("[x]") || content.startsWith("[X]")) {
        return (
          <li
            className={
              isCompact
                ? "flex items-start gap-2 text-sm"
                : "flex items-start gap-2"
            }
            {...props}
          >
            <CheckCircle
              className={
                isCompact
                  ? "mt-0.5 size-3.5 shrink-0 text-emerald-500"
                  : "mt-0.5 size-4 shrink-0 text-emerald-500"
              }
            />
            <span className="text-muted-foreground line-through">
              {content.slice(4)}
            </span>
          </li>
        );
      }
      return (
        <li className={isCompact ? "text-sm" : undefined} {...props}>
          {children}
        </li>
      );
    },
    p: ({ children }) => (
      <p className={isCompact ? "my-2 text-sm" : "my-3"}>{children}</p>
    ),
  };
}
