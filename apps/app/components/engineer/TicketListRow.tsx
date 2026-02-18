import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  ExternalLink,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import type { TicketCardProps } from "@/components/engineer/TicketCard";
import {
  getStatusStyles,
  getWorkflowProgress,
  shouldShowPlanningButton,
  WorkflowProgress,
} from "@/components/engineer/TicketCard";
import { prReviewsOptions } from "@/lib/engineer/queries/git";

/**
 * Status dot color mapping — matches the badge palette but as a filled circle.
 */
const getStatusDotColor = (statusType: string): string => {
  const colors: Record<string, string> = {
    triage: "bg-amber-500",
    backlog: "bg-muted-foreground/40",
    unstarted: "bg-sky-500",
    started: "bg-sky-500",
    completed: "bg-emerald-500",
    canceled: "bg-rose-500",
  };
  return colors[statusType] || "bg-muted-foreground/40";
};

/**
 * Parse owner and repo from GitHub PR URL
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull/.exec(url);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Compact horizontal row for list view — same data as TicketCard, dense layout.
 */
export function TicketListRow({
  ticket,
  onStartPlanning,
  isRunning,
  isLaunching,
  hasWorkDirectory,
  worktreePath,
  onDeleteWorktree,
  symphonyCompleted,
  symphonyExecuting,
  symphonyAwaitingUser,
  hasPushed,
  prInfo,
  onAskClaude,
  isStarred,
  onToggleStar,
  taskProgress,
  deployInfo,
  onTeardown,
  pendingClaudeMdPath,
  branchMerged,
  onLearningsClick,
  onReopen,
  parentTicketId,
  onParentClick,
}: Readonly<TicketCardProps>) {
  const isSymphonyActive = !!(isRunning || isLaunching);
  const workflowProgress = getWorkflowProgress({
    hasWorkDirectory: hasWorkDirectory ?? false,
    symphonyCompleted: symphonyCompleted ?? false,
    hasPushed: hasPushed ?? false,
    hasPR: !!prInfo,
    symphonyExecuting,
    isRunning,
    symphonyAwaitingUser,
    taskProgress,
  });

  // Fetch PR reviews
  const githubInfo = prInfo?.url ? parseGitHubUrl(prInfo.url) : null;
  const { data: reviewsData } = useQuery({
    ...prReviewsOptions(githubInfo?.owner, githubInfo?.repo, prInfo?.number),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Primary action button
  const showPlanningButton =
    !isSymphonyActive &&
    shouldShowPlanningButton(ticket.status.type, hasWorkDirectory ?? false);

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 bg-card px-4 py-3 transition-colors hover:bg-muted/50",
        isRunning && "animate-pulse border-l-2 border-l-primary"
      )}
    >
      {/* Line 1: status dot | identifier | title | status badge | progress */}
      <div className="flex min-w-0 items-center gap-3">
        {/* Status dot */}
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            getStatusDotColor(ticket.status.type)
          )}
          title={ticket.status.name}
        />

        {/* Identifier */}
        <a
          className="group/link inline-flex shrink-0 items-center gap-1 font-medium font-mono text-muted-foreground text-xs transition-colors hover:text-primary"
          href={ticket.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {ticket.identifier}
          <ExternalLink className="size-3 opacity-0 transition-opacity group-hover/link:opacity-100" />
        </a>

        {/* Source type label */}
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
          {ticket.sourceType}
        </span>

        {/* Title + Description */}
        <div className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {ticket.title}
          </span>
          {ticket.description && (
            <span className="block truncate text-muted-foreground/60 text-xs">
              {ticket.description}
            </span>
          )}
        </div>

        {/* Status badge */}
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 font-medium text-xs",
            getStatusStyles(ticket.status.type)
          )}
        >
          {ticket.status.name}
        </span>

        {/* Inline workflow progress */}
        {workflowProgress > 0 && ticket.status.type !== "completed" && (
          <div className="w-16 shrink-0">
            <WorkflowProgress
              className="!space-y-0 [&>div:last-child]:hidden"
              isRunning={isRunning}
              progress={workflowProgress}
            />
          </div>
        )}
      </div>

      {/* Line 2: badges + action button */}
      <div className="flex min-w-0 items-center gap-2 pl-5">
        {/* Star indicator — desktop only (on mobile the always-visible toggle suffices) */}
        {isStarred && (
          <Star className="hidden size-3 shrink-0 fill-amber-500 text-amber-500 sm:block" />
        )}

        {/* Stacked On badge */}
        {parentTicketId && (
          <button
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
            onClick={() => onParentClick?.(parentTicketId)}
            type="button"
          >
            <GitMerge className="size-2.5" />
            {parentTicketId}
          </button>
        )}

        {/* Learnings indicator */}
        {pendingClaudeMdPath && (
          <button
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium text-[10px]",
              "shrink-0 bg-violet-500/10 text-violet-700 dark:text-violet-400",
              branchMerged && !isRunning
                ? "cursor-pointer transition-colors hover:bg-violet-500/20"
                : "cursor-default opacity-75"
            )}
            disabled={!branchMerged || !!isRunning}
            onClick={(e) => {
              e.stopPropagation();
              if (branchMerged && !isRunning && onLearningsClick) {
                onLearningsClick(ticket, pendingClaudeMdPath);
              }
            }}
          >
            <BookMarked className="size-2.5" />
            Learnings
          </button>
        )}

        {/* PR link */}
        {prInfo && (
          <a
            className="inline-flex shrink-0 items-center gap-1 font-medium text-[10px] text-muted-foreground transition-colors hover:text-primary"
            href={prInfo.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitPullRequest className="size-2.5" />
            PR #{prInfo.number}
          </a>
        )}

        {/* PR review status (compact) */}
        {reviewsData && prInfo && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 font-medium text-[10px]",
              reviewsData.approvalCount > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : reviewsData.changesRequestedCount > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground"
            )}
          >
            {reviewsData.approvalCount > 0 ? (
              <>
                <CheckCircle2 className="size-2.5" /> Approved
              </>
            ) : reviewsData.changesRequestedCount > 0 ? (
              <>
                <AlertCircle className="size-2.5" /> Changes
              </>
            ) : null}
          </span>
        )}

        {/* Deploy info */}
        {deployInfo?.status === "deployed" && deployInfo.url && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px]">
            <span
              className={
                deployInfo.healthCheckFailed
                  ? "text-amber-500"
                  : "text-emerald-500"
              }
            >
              {"\u25CF"}
            </span>
            <a
              className="text-muted-foreground transition-colors hover:text-foreground"
              href={deployInfo.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              Dev Server
            </a>
            {onTeardown && (
              <button
                className="cursor-pointer p-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  onTeardown(ticket.identifier);
                }}
                title="Stop dev server"
              >
                <Square className="size-2.5 text-muted-foreground transition-colors hover:text-destructive" />
              </button>
            )}
          </span>
        )}

        {/* Branch merged badge */}
        {branchMerged && (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-[10px] text-emerald-600 dark:text-emerald-400">
            <GitMerge className="size-2.5" />
            Merged
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Secondary hover actions */}
        <div className="flex shrink-0 items-center gap-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
          {onToggleStar && (
            <button
              className={cn(
                "cursor-pointer rounded-md p-1 transition-colors",
                isStarred
                  ? "text-amber-500 hover:text-amber-600"
                  : "text-muted-foreground/40 hover:text-amber-500"
              )}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar(ticket.identifier);
              }}
              title={isStarred ? "Remove from Next Up" : "Add to Next Up"}
            >
              <Star className={cn("size-3.5", isStarred && "fill-current")} />
            </button>
          )}
          {onAskClaude && (
            <button
              className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:text-violet-600 dark:hover:text-violet-400"
              onClick={(e) => {
                e.stopPropagation();
                onAskClaude(ticket);
              }}
              title="Ask Claude"
            >
              <Sparkles className="size-3.5" />
            </button>
          )}
          {hasWorkDirectory &&
            worktreePath &&
            onDeleteWorktree &&
            !isSymphonyActive && (
              <button
                className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteWorktree(ticket.identifier, worktreePath);
                }}
                title="Delete worktree"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
        </div>

        {/* Primary action button */}
        {showPlanningButton && onStartPlanning && (
          <Button
            className="h-7 shrink-0 px-3 text-xs"
            onClick={() => onStartPlanning(ticket.identifier)}
            size="sm"
            variant={hasWorkDirectory ? "outline" : "default"}
          >
            {hasWorkDirectory ? (
              <>
                <FolderGit2 className="mr-1.5 size-3" />
                Resume
              </>
            ) : (
              "Start Planning"
            )}
          </Button>
        )}

        {/* Launching indicator */}
        {isLaunching && (
          <span className="flex shrink-0 items-center gap-1.5 text-primary text-xs">
            <Loader2 className="size-3 animate-spin" />
            Launching...
          </span>
        )}

        {/* Reopen button for completed tickets */}
        {onReopen && ticket.status.type === "completed" && (
          <Button
            className="h-7 shrink-0 px-3 text-muted-foreground text-xs hover:text-foreground"
            onClick={() => onReopen(ticket.identifier)}
            size="sm"
            variant="ghost"
          >
            <RotateCcw className="mr-1.5 size-3" />
            Reopen
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Skeleton placeholder for list row loading state.
 */
export function TicketListRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="size-2 rounded-full" />
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-3.5 w-48" />
      <div className="flex-1" />
      <Skeleton className="h-5 w-20 rounded-full" />
    </div>
  );
}
