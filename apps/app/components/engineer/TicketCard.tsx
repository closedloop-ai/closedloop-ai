import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import type { EngineerTicket } from "@/types/engineer";

/** Toggle pulsing glow border on running cards */
const ENABLE_RUNNING_GLOW = true;

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  ExternalLink,
  ExternalLinkIcon,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import { SymphonyStatus } from "@/components/engineer/SymphonyStatus";
import {
  type PRReviewsResponse,
  prReviewsOptions,
} from "@/lib/engineer/queries/git";

/**
 * Parse owner and repo from GitHub PR URL
 * e.g., https://github.com/owner/repo/pull/123 -> { owner: "owner", repo: "repo" }
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull/.exec(url);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Workflow progress stages with labels
 */
const WORKFLOW_STAGES = [
  { key: "plan", label: "Plan created", activeLabel: "Planning" },
  { key: "code", label: "Code complete", activeLabel: "Coding" },
  { key: "push", label: "Changes pushed", activeLabel: "Pushing" },
  { key: "pr", label: "PR created", activeLabel: "Creating PR" },
] as const;

/**
 * Calculate workflow progress based on ticket state.
 * Returns 0-4 (fractional during coding) representing completed stages.
 *
 * During coding, progress is fractional (1.0–2.0) based on plan.json
 * task completion: 1 + (completedTasks / totalTasks).
 *
 * NOTE: `symphonyExecuting` means the user has accepted the plan and coding
 * is underway. Do NOT derive coding status from planExists or symphony phase
 * alone — plan.json can exist during planning, and phase may briefly show
 * "Planning" on resume before transitioning to coding.
 */
export type WorkflowState = {
  hasWorkDirectory: boolean;
  symphonyCompleted: boolean;
  hasPushed: boolean;
  hasPR: boolean;
  symphonyExecuting?: boolean;
  isRunning?: boolean;
  symphonyAwaitingUser?: boolean;
  taskProgress?: { pending: number; completed: number; total: number };
};

export function getWorkflowProgress(state: WorkflowState): number {
  if (state.hasPR) {
    return 4;
  }
  if (state.hasPushed) {
    return 3;
  }
  if (state.symphonyCompleted) {
    return 2;
  }
  if (state.symphonyExecuting) {
    // During coding, use task progress to show granular progress from 1.0 to 2.0
    // (25% to 50% of the overall bar).
    // Use a small minimum (0.01) so the stage label shows "Coding..." not "Planning..."
    const tp = state.taskProgress;
    if (tp && tp.total > 0) {
      return 1 + Math.max(tp.completed / tp.total, 0.01);
    }
    return 1.01; // Coding started but no task data yet
  }
  if (state.symphonyAwaitingUser) {
    return 1; // Plan created, awaiting user acceptance
  }
  if (state.hasWorkDirectory) {
    return 1;
  }
  if (state.isRunning) {
    return 1; // Symphony running but plan not yet created
  }
  return 0;
}

/**
 * Workflow progress indicator component
 * Shows 4 stages: Plan → Code → Push → PR
 * Supports fractional progress (e.g., 1.5 = halfway through coding)
 */
export function WorkflowProgress({
  progress,
  className,
  isRunning = false,
}: Readonly<{
  progress: number;
  className?: string;
  isRunning?: boolean;
}>) {
  if (progress === 0) {
    return null;
  }

  const percentage = Math.round((progress / 4) * 100);
  const isComplete = progress >= 4;
  // For fractional progress, ceil gives us the current stage index
  const currentStageIndex = Math.ceil(progress) - 1;
  const currentStage = WORKFLOW_STAGES[currentStageIndex];
  // Number of fully completed stages (for the solid bar behind the current segment)
  const completedStages = Math.floor(progress);
  // How far into the current stage (0 to 1). For integer progress, this is 0 (stage fully done).
  const currentStageFraction = progress - completedStages;

  return (
    <div className={cn("space-y-1.5", className)}>
      {/* Progress bar container */}
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        {/* Fully completed stages (solid bar) */}
        {completedStages > 0 && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-l-full transition-all duration-500 ease-out",
              isComplete
                ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                : "bg-primary"
            )}
            style={{ width: `${(completedStages / 4) * 100}%` }}
          />
        )}
        {/* Current stage segment (partially filled, pulses when running) */}
        {currentStageFraction > 0 && (
          <div
            className={cn(
              "absolute inset-y-0 transition-all duration-500 ease-out",
              isRunning ? "bg-primary/75" : "bg-primary",
              isRunning && "animate-pulse",
              completedStages === 0 && "rounded-l-full",
              "rounded-r-full"
            )}
            style={{
              left: `${(completedStages / 4) * 100}%`,
              width: `${(currentStageFraction / 4) * 100}%`,
            }}
          />
        )}
        {/* Stage markers */}
        <div className="absolute inset-0 flex">
          {WORKFLOW_STAGES.map((stage, i) => {
            const filledColor = isComplete
              ? "bg-emerald-200/80"
              : "bg-primary/30";
            return (
              <div
                className="flex flex-1 items-center justify-end pr-0.5"
                key={stage.key}
              >
                {i < WORKFLOW_STAGES.length - 1 && (
                  <div
                    className={cn(
                      "size-1 rounded-full transition-all duration-300",
                      i < progress ? filledColor : "bg-muted-foreground/20"
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Current stage label */}
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-xs",
            isComplete
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          )}
        >
          {isRunning && !isComplete
            ? `${currentStage.activeLabel}...`
            : currentStage.label}
        </span>
        <span className="text-muted-foreground/60 text-xs">{percentage}%</span>
      </div>
    </div>
  );
}

export type TicketCardProps = {
  ticket: EngineerTicket;
  onStartPlanning?: (ticketId: string) => void;
  isRunning?: boolean;
  isLaunching?: boolean;
  repoPath?: string | null;
  hasWorkDirectory?: boolean;
  /** Path to the worktree directory */
  worktreePath?: string | null;
  onCommitPush?: (ticketId: string) => void;
  onCreatePR?: () => void;
  /** Handler to delete the worktree */
  onDeleteWorktree?: (ticketId: string, worktreePath: string) => void;
  /** Symphony has completed execution */
  symphonyCompleted?: boolean;
  /** Symphony is actively executing code (past planning phase) */
  symphonyExecuting?: boolean;
  /** Plan is created and awaiting user acceptance */
  symphonyAwaitingUser?: boolean;
  /** Changes have been pushed to remote */
  hasPushed?: boolean;
  /** PR info if created */
  prInfo?: { url: string; number: number } | null;
  /** PR creation in progress */
  isCreatingPR?: boolean;
  /** Handler to open Ask Claude dialog */
  onAskClaude?: (ticket: EngineerTicket) => void;
  /** Handler to reopen a completed ticket */
  onReopen?: (ticketId: string) => void;
  /** Whether this ticket is starred (next up) */
  isStarred?: boolean;
  /** Handler to toggle star on a pending ticket */
  onToggleStar?: (ticketId: string) => void;
  /** Task progress from plan.json (pending/completed counts) */
  taskProgress?: { pending: number; completed: number; total: number };
  /** Deployment info if deployed */
  deployInfo?: {
    url: string;
    deployedAt: string;
    status: string;
    healthCheckFailed?: boolean;
  } | null;
  /** Whether this repo has a deployment config */
  isDeployable?: boolean;
  /** Handler to open deploy dialog */
  onDeploy?: (ticketId: string) => void;
  /** Whether deployment is currently running */
  isDeploying?: boolean;
  /** Handler to tear down a deployment */
  onTeardown?: (ticketId: string) => void;
  /** Symphony was stopped by the user */
  symphonyStopped?: boolean;
  /** Handler to stop a running Symphony process */
  onStopSymphony?: (ticketId: string) => void;
  /** Handler to resume Symphony execution after plan update */
  onResumeExecution?: (ticketId: string) => void;
  /** Whether resume execution is in progress */
  isResuming?: boolean;
  /** Path to CLAUDE.md if it has uncommitted changes */
  pendingClaudeMdPath?: string | null;
  /** Whether the branch has been merged (remote deleted) */
  branchMerged?: boolean;
  /** Handler when learnings indicator is clicked */
  onLearningsClick?: (ticket: EngineerTicket, claudeMdPath: string) => void;
  /** Parent ticket ID if this ticket is stacked on another */
  parentTicketId?: string;
  /** Child ticket IDs if other tickets are stacked on this one */
  childTicketIds?: string[];
  /** Handler for clicking the parent ticket badge */
  onParentClick?: (parentTicketId: string) => void;
  /** Whether Codex CLI is available for code reviews */
  codexAvailable?: boolean;
  /** Whether a Codex review is currently running */
  codexReviewRunning?: boolean;
  /** Handler to open Codex review dialog */
  onCodexReview?: (ticketId: string) => void;
  /** Handler to open LinkPR dialog */
  onLinkPR?: (ticketId: string) => void;
  /** Handler to view PR comments */
  onViewComments?: (ticketId: string) => void;
};

/**
 * Status badge color and styling based on status type
 * Using a refined, muted palette that works in both light and dark modes
 */
export const getStatusStyles = (
  statusType: EngineerTicket["status"]["type"]
): string => {
  const styles: Record<EngineerTicket["status"]["type"], string> = {
    triage: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    backlog: "bg-muted text-muted-foreground",
    unstarted: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    started: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    canceled: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  };
  return styles[statusType];
};

/**
 * Determines if the "Start Planning" or "Resume" button should be shown.
 */
export const shouldShowPlanningButton = (
  statusType: EngineerTicket["status"]["type"],
  hasWorkDirectory: boolean
): boolean => {
  // Always show for tickets with existing work (resume)
  if (hasWorkDirectory) {
    return true;
  }
  // Show for unstarted/backlog tickets (start fresh)
  if (statusType === "unstarted" || statusType === "backlog") {
    return true;
  }
  // Show for started tickets without work directory
  if (statusType === "started") {
    return true;
  }
  // Show for completed tickets (reopened tickets still have completed status in Linear)
  if (statusType === "completed") {
    return true;
  }
  return false;
};

export function ReviewStatusBadge({
  reviewsData,
}: Readonly<{ reviewsData: PRReviewsResponse }>) {
  if (reviewsData.approvalCount > 0) {
    return (
      <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-4" />
        <span className="font-medium">
          {reviewsData.approvalCount} approved
        </span>
      </span>
    );
  }
  if (reviewsData.changesRequestedCount > 0) {
    return (
      <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <AlertCircle className="size-4" />
        <span className="font-medium">
          {reviewsData.changesRequestedCount} changes requested
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <GitPullRequest className="size-4" />
      <span className="font-medium">Awaiting review</span>
    </span>
  );
}

/**
 * Props for TicketCardActions component
 */
type TicketCardActionsProps = {
  ticket: EngineerTicket;
  isSymphonyActive: boolean;
  hasWorkDirectory?: boolean;
  worktreePath?: string | null;
  repoPath?: string | null;
  isLaunching?: boolean;
  isRunning?: boolean;
  symphonyCompleted?: boolean;
  symphonyAwaitingUser?: boolean;
  hasPushed?: boolean;
  prInfo?: { url: string; number: number } | null;
  isCreatingPR?: boolean;
  isResuming?: boolean;
  isDeploying?: boolean;
  deployInfo?: {
    url: string;
    deployedAt: string;
    status: string;
    healthCheckFailed?: boolean;
  } | null;
  reviewsData?: PRReviewsResponse;
  onStartPlanning?: (ticketId: string) => void;
  onDeleteWorktree?: (ticketId: string, worktreePath: string) => void;
  symphonyStopped?: boolean;
  onStopSymphony?: (ticketId: string) => void;
  onCommitPush?: (ticketId: string) => void;
  onResumeExecution?: (ticketId: string) => void;
  onCreatePR?: () => void;
  onDeploy?: (ticketId: string) => void;
  onTeardown?: (ticketId: string) => void;
  onReopen?: (ticketId: string) => void;
  codexAvailable?: boolean;
  codexReviewRunning?: boolean;
  onCodexReview?: (ticketId: string) => void;
  onLinkPR?: (ticketId: string) => void;
  onViewComments?: (ticketId: string) => void;
};

/**
 * Planning/Resume button with optional delete worktree
 */
function PlanningButton({
  ticket,
  hasWorkDirectory,
  worktreePath,
  onStartPlanning,
  onDeleteWorktree,
}: Readonly<{
  ticket: EngineerTicket;
  hasWorkDirectory?: boolean;
  worktreePath?: string | null;
  onStartPlanning?: (ticketId: string) => void;
  onDeleteWorktree?: (ticketId: string, worktreePath: string) => void;
}>) {
  if (!onStartPlanning) {
    return null;
  }
  if (
    !shouldShowPlanningButton(ticket.status.type, hasWorkDirectory ?? false)
  ) {
    return null;
  }

  return (
    <div className={cn("flex gap-2", hasWorkDirectory && "items-center")}>
      <Button
        className={cn("font-medium", hasWorkDirectory ? "flex-1" : "w-full")}
        onClick={() => onStartPlanning(ticket.identifier)}
        size="sm"
        variant={hasWorkDirectory ? "outline" : "default"}
      >
        {hasWorkDirectory ? (
          <>
            <FolderGit2 className="mr-2 size-4" />
            Resume Work
          </>
        ) : (
          "Start Planning"
        )}
      </Button>
      {hasWorkDirectory && worktreePath && onDeleteWorktree && (
        <Button
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onDeleteWorktree(ticket.identifier, worktreePath)}
          size="sm"
          title="Delete worktree"
          variant="ghost"
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * Commit & Push button (shown when completed but not pushed)
 */
function CommitPushButton({
  ticketId,
  isResuming,
  onCommitPush,
}: Readonly<{
  ticketId: string;
  isResuming?: boolean;
  onCommitPush?: (ticketId: string) => void;
}>) {
  if (!onCommitPush) {
    return null;
  }
  return (
    <Button
      className="w-full animate-pulse-glow"
      disabled={isResuming}
      onClick={() => onCommitPush(ticketId)}
      size="sm"
    >
      <GitBranch className="mr-2 size-4" />
      Commit & Push
    </Button>
  );
}

/**
 * PR info section with review status and View PR button
 */
function PRSection({
  prInfo,
  reviewsData,
}: Readonly<{
  prInfo: { url: string; number: number };
  reviewsData?: PRReviewsResponse;
}>) {
  return (
    <div className="space-y-2">
      {reviewsData && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <ReviewStatusBadge reviewsData={reviewsData} />
        </div>
      )}
      <Button
        className="w-full"
        onClick={() => globalThis.open(prInfo.url, "_blank")}
        size="sm"
        variant="outline"
      >
        <ExternalLinkIcon className="mr-2 size-4" />
        View PR #{prInfo.number}
      </Button>
    </div>
  );
}

/**
 * Deployed server info with health indicator and stop button
 */
export function DeployedInfo({
  deployInfo,
  ticketId,
  onTeardown,
}: Readonly<{
  deployInfo: { url: string; healthCheckFailed?: boolean };
  ticketId: string;
  onTeardown?: (ticketId: string) => void;
}>) {
  const url = new URL(deployInfo.url);
  const hostWithPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={
          deployInfo.healthCheckFailed ? "text-amber-500" : "text-emerald-500"
        }
        title={deployInfo.healthCheckFailed ? "Unreachable" : "Healthy"}
      >
        {"\u25CF"}
      </span>
      <span className="shrink-0 font-medium text-muted-foreground text-xs">
        Dev Server
      </span>
      <a
        className="flex-1 truncate text-foreground hover:underline"
        href={deployInfo.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {hostWithPort}
      </a>
      {onTeardown && (
        <button
          className="cursor-pointer rounded-md p-1"
          onClick={(e) => {
            e.stopPropagation();
            onTeardown(ticketId);
          }}
          title="Stop dev server"
        >
          <Square className="size-3.5 text-muted-foreground transition-colors hover:text-destructive" />
        </button>
      )}
    </div>
  );
}

/**
 * All action buttons for the ticket card
 * Handles the state machine for Symphony workflow actions
 */
/**
 * Header action buttons (star and ask claude)
 */
function TicketCardHeaderActions({
  ticket,
  isStarred,
  onToggleStar,
  onAskClaude,
}: Readonly<{
  ticket: EngineerTicket;
  isStarred?: boolean;
  onToggleStar?: (ticketId: string) => void;
  onAskClaude?: (ticket: EngineerTicket) => void;
}>) {
  return (
    <div className="flex items-center gap-1">
      {onToggleStar && (
        <button
          className={cn(
            "cursor-pointer rounded-md p-1.5 transition-colors",
            isStarred
              ? "text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400"
              : "text-muted-foreground/40 hover:bg-amber-500/10 hover:text-amber-500"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(ticket.identifier);
          }}
          title={isStarred ? "Remove from Next Up" : "Add to Next Up"}
        >
          <Star className={cn("size-4", isStarred && "fill-current")} />
        </button>
      )}
      {onAskClaude && (
        <button
          className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400"
          onClick={(e) => {
            e.stopPropagation();
            onAskClaude(ticket);
          }}
          title="Ask Claude about this ticket"
        >
          <Sparkles className="size-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Pending learnings indicator badge
 */
export function LearningsIndicator({
  ticket,
  pendingClaudeMdPath,
  branchMerged,
  isRunning,
  onLearningsClick,
}: Readonly<{
  ticket: EngineerTicket;
  pendingClaudeMdPath: string;
  branchMerged?: boolean;
  isRunning?: boolean;
  onLearningsClick?: (ticket: EngineerTicket, claudeMdPath: string) => void;
}>) {
  const isClickable = branchMerged && !isRunning;

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs",
        "bg-violet-500/10 text-violet-700 dark:text-violet-400",
        isClickable
          ? "cursor-pointer transition-colors hover:bg-violet-500/20"
          : "cursor-default opacity-75"
      )}
      disabled={!isClickable}
      onClick={(e) => {
        e.stopPropagation();
        if (isClickable && onLearningsClick) {
          onLearningsClick(ticket, pendingClaudeMdPath);
        }
      }}
      title={pendingClaudeMdPath}
    >
      <BookMarked className="size-3" />
      <span className="hidden sm:inline">Learnings</span>
    </button>
  );
}

function TicketCardActions({
  ticket,
  isSymphonyActive,
  hasWorkDirectory,
  worktreePath,
  repoPath,
  isLaunching,
  isRunning,
  symphonyCompleted,
  hasPushed,
  prInfo,
  isCreatingPR,
  isResuming,
  deployInfo,
  reviewsData,
  symphonyStopped,
  onStartPlanning,
  onDeleteWorktree,
  onStopSymphony,
  onCommitPush,
  onResumeExecution,
  onCreatePR,
  onTeardown,
  onReopen,
  onLinkPR,
  onViewComments,
}: Readonly<TicketCardActionsProps>) {
  return (
    <div className="mt-6 space-y-3">
      {/* Launching indicator */}
      {isLaunching && (
        <div className="flex items-center gap-2 text-primary">
          <Loader2 className="size-4 animate-spin" />
          <span className="font-medium text-sm">
            Launching Closedloop.dev...
          </span>
        </div>
      )}

      {/* Real-time status - show when running or stopped, hide when completed */}
      {(isRunning || symphonyStopped) && repoPath && !symphonyCompleted && (
        <SymphonyStatus
          onResume={
            onResumeExecution
              ? () => onResumeExecution(ticket.identifier)
              : undefined
          }
          onStop={
            onStopSymphony ? () => onStopSymphony(ticket.identifier) : undefined
          }
          repoPath={repoPath}
          ticketId={ticket.identifier}
        />
      )}

      {/* Start Planning / Resume Button */}
      {!isSymphonyActive && (
        <PlanningButton
          hasWorkDirectory={hasWorkDirectory}
          onDeleteWorktree={onDeleteWorktree}
          onStartPlanning={onStartPlanning}
          ticket={ticket}
          worktreePath={worktreePath}
        />
      )}

      {/* State 1: Completed but not pushed */}
      {symphonyCompleted && !hasPushed && !isSymphonyActive && (
        <CommitPushButton
          isResuming={isResuming}
          onCommitPush={onCommitPush}
          ticketId={ticket.identifier}
        />
      )}

      {/* State 2: Pushed but no PR */}
      {symphonyCompleted &&
        hasPushed &&
        !prInfo &&
        !isSymphonyActive &&
        onCreatePR && (
          <Button
            className="w-full"
            disabled={isCreatingPR}
            onClick={onCreatePR}
            size="sm"
          >
            {isCreatingPR ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Creating PR...
              </>
            ) : (
              <>
                <GitPullRequest className="mr-2 size-4" />
                Create PR
              </>
            )}
          </Button>
        )}

      {/* State 3: PR created (hide for completed tickets) */}
      {prInfo && ticket.status.type !== "completed" && (
        <PRSection prInfo={prInfo} reviewsData={reviewsData} />
      )}

      {/* Link PR button — only when no PR, no active Symphony, and handler provided */}
      {!(prInfo || isSymphonyActive) && onLinkPR && (
        <Button
          className="w-full"
          onClick={() => onLinkPR(ticket.identifier)}
          size="sm"
          variant="outline"
        >
          <GitPullRequest className="mr-2 size-4" />
          Link PR
        </Button>
      )}

      {/* PR Comments button — when PR exists and handler provided */}
      {prInfo && onViewComments && (
        <Button
          className="w-full"
          onClick={() => onViewComments(ticket.identifier)}
          size="sm"
          variant="outline"
        >
          <MessageSquare className="mr-2 size-4" />
          PR Comments
        </Button>
      )}

      {/* Deployed info */}
      {deployInfo?.status === "deployed" && deployInfo.url && (
        <DeployedInfo
          deployInfo={deployInfo}
          onTeardown={onTeardown}
          ticketId={ticket.identifier}
        />
      )}

      {/* Reopen button for completed tickets */}
      {onReopen && ticket.status.type === "completed" && (
        <Button
          className="w-full text-muted-foreground hover:text-foreground"
          onClick={() => onReopen(ticket.identifier)}
          size="sm"
          variant="ghost"
        >
          <RotateCcw className="mr-2 size-4" />
          Reopen
        </Button>
      )}
    </div>
  );
}

/**
 * TicketCard component with editorial styling
 */
export function TicketCard({
  ticket,
  onStartPlanning,
  isRunning,
  isLaunching,
  repoPath,
  hasWorkDirectory,
  worktreePath,
  onCommitPush,
  onCreatePR,
  onDeleteWorktree,
  symphonyCompleted,
  hasPushed,
  prInfo,
  isCreatingPR,
  onAskClaude,
  onReopen,
  isStarred,
  onToggleStar,
  symphonyExecuting,
  symphonyAwaitingUser,
  taskProgress,
  deployInfo,
  onDeploy,
  isDeploying,
  onTeardown,
  symphonyStopped,
  onStopSymphony,
  onResumeExecution,
  isResuming,
  pendingClaudeMdPath,
  branchMerged,
  onLearningsClick,
  parentTicketId,
  childTicketIds,
  onParentClick,
  codexAvailable,
  codexReviewRunning,
  onCodexReview,
  onLinkPR,
  onViewComments,
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

  // Parse GitHub URL to get owner/repo for reviews API
  const githubInfo = prInfo?.url ? parseGitHubUrl(prInfo.url) : null;

  // Fetch PR reviews when we have a PR
  const { data: reviewsData } = useQuery({
    ...prReviewsOptions(githubInfo?.owner, githubInfo?.repo, prInfo?.number),
    staleTime: 30_000, // Cache for 30 seconds
    refetchInterval: 60_000, // Refresh every minute
  });

  return (
    <article
      className={cn(
        "card-editorial flex h-full flex-col rounded-xl",
        ENABLE_RUNNING_GLOW && isRunning && "card-running"
      )}
    >
      {/* Header section */}
      <div className="p-5 pb-0 sm:p-6">
        {/* Ticket ID with external link and Ask Claude button */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <a
              className="group inline-flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs transition-colors hover:text-primary"
              href={ticket.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {ticket.identifier}
              <ExternalLink className="size-3 -translate-y-0.5 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100" />
            </a>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
              {ticket.sourceType}
            </span>
          </div>
          <TicketCardHeaderActions
            isStarred={isStarred}
            onAskClaude={onAskClaude}
            onToggleStar={onToggleStar}
            ticket={ticket}
          />
        </div>

        {/* Title */}
        <h3 className="mb-3 line-clamp-2 min-h-[3.5rem] font-medium text-lg leading-snug sm:text-xl">
          {ticket.title}
        </h3>

        {/* Description */}
        {ticket.description && (
          <p className="line-clamp-2 whitespace-pre-line text-muted-foreground text-sm leading-relaxed">
            {ticket.description
              .replaceAll(/!\[.*?\]\(.*?\)/g, "")
              .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
              .replaceAll(/[*_#`]/g, "")
              .replaceAll(/[^\S\n]{2,}/g, " ")
              .trim()}
          </p>
        )}
      </div>

      {/* Content section */}
      <div className="flex flex-1 flex-col p-5 pt-4 sm:p-6">
        {/* Status Badge & Progress */}
        <div className="mb-auto flex flex-wrap items-center gap-2">
          <span
            className={cn("badge-status", getStatusStyles(ticket.status.type))}
          >
            {ticket.status.name}
          </span>

          {/* Stacked On Badge */}
          {parentTicketId && (
            <button
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                "border border-border/50 bg-muted/50 text-muted-foreground text-xs",
                "hover:border-primary/30 hover:bg-primary/5 hover:text-primary",
                "cursor-pointer transition-colors"
              )}
              onClick={() => onParentClick?.(parentTicketId)}
              title={`This worktree was created from ${parentTicketId}'s branch. ${parentTicketId} should be merged first.`}
              type="button"
            >
              <GitMerge className="size-3" />
              <span>Based on {parentTicketId}</span>
            </button>
          )}

          {/* Has Dependents Badge */}
          {childTicketIds && childTicketIds.length > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                "border border-amber-500/20 bg-amber-500/10 text-amber-600 text-xs dark:text-amber-400"
              )}
              title={`${childTicketIds.length} ticket(s) depend on this branch: ${childTicketIds.join(", ")}`}
            >
              <GitMerge className="size-3" />
              <span>{childTicketIds.length} dependent</span>
            </span>
          )}

          {/* Pending Learnings Indicator */}
          {pendingClaudeMdPath && (
            <LearningsIndicator
              branchMerged={branchMerged}
              isRunning={isRunning}
              onLearningsClick={onLearningsClick}
              pendingClaudeMdPath={pendingClaudeMdPath}
              ticket={ticket}
            />
          )}
        </div>

        {/* Workflow Progress Indicator - hide for completed tickets */}
        {workflowProgress > 0 && ticket.status.type !== "completed" && (
          <WorkflowProgress
            className="mt-4"
            isRunning={isRunning}
            progress={workflowProgress}
          />
        )}

        {/* Action area */}
        <TicketCardActions
          codexAvailable={codexAvailable}
          codexReviewRunning={codexReviewRunning}
          deployInfo={deployInfo}
          hasPushed={hasPushed}
          hasWorkDirectory={hasWorkDirectory}
          isCreatingPR={isCreatingPR}
          isDeploying={isDeploying}
          isLaunching={isLaunching}
          isResuming={isResuming}
          isRunning={isRunning}
          isSymphonyActive={isSymphonyActive}
          onCodexReview={onCodexReview}
          onCommitPush={onCommitPush}
          onCreatePR={onCreatePR}
          onDeleteWorktree={onDeleteWorktree}
          onDeploy={onDeploy}
          onLinkPR={onLinkPR}
          onReopen={onReopen}
          onResumeExecution={onResumeExecution}
          onStartPlanning={onStartPlanning}
          onStopSymphony={onStopSymphony}
          onTeardown={onTeardown}
          onViewComments={onViewComments}
          prInfo={prInfo}
          repoPath={repoPath}
          reviewsData={reviewsData}
          symphonyCompleted={symphonyCompleted}
          symphonyStopped={symphonyStopped}
          ticket={ticket}
          worktreePath={worktreePath}
        />
      </div>
    </article>
  );
}
