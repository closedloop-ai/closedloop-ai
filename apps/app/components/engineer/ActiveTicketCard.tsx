/* eslint-disable react-hooks/set-state-in-effect */

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  GitBranch,
  Loader2,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Rocket,
  RotateCcw,
  Scale,
  ScanEye,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { JudgesViewer } from "@/components/engineer/JudgesViewer";
import { LogViewer } from "@/components/engineer/LogViewer";
import { PlanViewer } from "@/components/engineer/PlanViewer";
import {
  type LeftPaneTab,
  SymphonyChat,
} from "@/components/engineer/SymphonyChat";
import { TicketCard } from "@/components/engineer/TicketCard";
import {
  symphonyChatHistoryOptions,
  symphonyLogsOptions,
  symphonyPlanOptions,
  symphonyStatusOptions,
} from "@/lib/engineer/queries/symphony";
import type { EngineerTicket } from "@/types/engineer";

type ActiveTicketCardProps = {
  ticket: EngineerTicket;
  isLaunching: boolean;
  repoPath: string | null;
  contextRepoPaths?: string[];
  hasWorkDirectory: boolean;
  hasPushed: boolean;
  prInfo: { url: string; number: number } | null;
  isCreatingPR?: boolean;
  onResume?: () => void;
  onCommitPush?: (ticketId: string) => void;
  onCreatePR?: (ticketId: string, repoPath: string) => void;
  onClose?: () => void;
  deployInfo?: {
    url: string;
    deployedAt: string;
    status: string;
    healthCheckFailed?: boolean;
  } | null;
  isDeployable?: boolean;
  onDeploy?: (ticketId: string) => void;
  isDeploying?: boolean;
  onTeardown?: (ticketId: string) => void;
  onStopSymphony?: (ticketId: string) => void;
  onResumeExecution?: (ticketId: string) => void;
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
};

/**
 * A ticket card with a sliding plan panel that overlays from the right.
 * A vertical "Plan" tab appears on the card's right edge when a plan exists.
 */
function ButtonLabel({
  isLaunching,
  isExecuting,
}: Readonly<{ isLaunching: boolean; isExecuting: boolean }>) {
  if (isLaunching) {
    return (
      <>
        <Loader2 className="mr-2 size-4 animate-spin" />
        Launching...
      </>
    );
  }
  if (isExecuting) {
    return (
      <>
        <Loader2 className="mr-2 size-4 animate-spin" />
        Closedloop.dev Running...
      </>
    );
  }
  return <>Accept Plan &amp; Continue</>;
}

export function ActiveTicketCard({
  ticket,
  isLaunching,
  repoPath,
  contextRepoPaths,
  hasWorkDirectory,
  hasPushed,
  prInfo,
  isCreatingPR,
  onResume,
  onCommitPush,
  onCreatePR,
  onClose,
  deployInfo,
  isDeployable,
  onDeploy,
  isDeploying,
  onTeardown,
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
}: Readonly<ActiveTicketCardProps>) {
  const [isPlanOpen, setIsPlanOpen] = useState(false);
  const [isAcceptingPlan, setIsAcceptingPlan] = useState(false);

  // Track whether the user has accepted the plan for this ticket.
  // Persisted in localStorage so it survives page refreshes and stop/resume cycles.
  // IMPORTANT: Do NOT derive "isCoding" from planExists or symphony phase alone.
  // During planning, plan.json may already exist on disk, and after a resume the
  // symphony briefly re-enters "Phase 1: Planning" before moving to coding.
  // The only reliable signal is that the user explicitly accepted the plan.
  const planAcceptedKey = `plan-accepted:${ticket.identifier}`;
  const [hasPlanAccepted, setHasPlanAccepted] = useState(() => {
    if (globalThis.window === undefined) {
      return false;
    }
    return localStorage.getItem(planAcceptedKey) === "true";
  });

  // Poll Symphony status to check if it's actively executing
  const { data: symphonyStatus } = useQuery({
    ...symphonyStatusOptions(ticket.identifier, repoPath),
    refetchInterval: 3000, // Poll every 3 seconds
  });

  // Symphony is executing if status is IN_PROGRESS
  const isExecuting = symphonyStatus?.status === "IN_PROGRESS";

  // Symphony is in the coding phase only if the user has explicitly accepted the plan.
  const isCoding = isExecuting && hasPlanAccepted;

  // Symphony code is fully completed (all phases done).
  const isCompleted = symphonyStatus?.status === "COMPLETED";

  // Symphony was stopped by the user.
  const isStopped = symphonyStatus?.status === "STOPPED";

  // Plan is ready for user review (not code-complete yet)
  const isAwaitingUser = symphonyStatus?.status === "AWAITING_USER";

  // Clear "accepting plan" state once Symphony starts executing, completes, or awaits user
  useEffect(() => {
    if (isExecuting || isCompleted || isAwaitingUser) {
      setIsAcceptingPlan(false);
    }
  }, [isExecuting, isCompleted, isAwaitingUser]);

  // Show launching state when: explicitly launching, accepting plan,
  // or active session exists but Symphony hasn't reported any status yet (the gap
  // between launch API returning and Symphony's first status poll)
  const isWaitingForSymphony =
    !!repoPath && !isExecuting && !isCompleted && !symphonyStatus?.status;
  const isLaunchingOrAccepting =
    isLaunching || isAcceptingPlan || isWaitingForSymphony || !!isResuming;

  const hasActiveSession = !!repoPath;

  // Detect whether a plan exists (used to show/hide the Plan tab)
  const { data: planData } = useQuery({
    ...symphonyPlanOptions(ticket.identifier, repoPath ?? ""),
    enabled: hasActiveSession,
  });
  const hasPlan = !!planData?.planExists;

  // Chat / Logs / Judges state (lifted from PlanViewer)
  const [showChat, setShowChat] = useState(false);
  const [chatInitialTab, setChatInitialTab] = useState<LeftPaneTab | undefined>(
    undefined
  );
  const [showLogs, setShowLogs] = useState(false);
  const [showJudges, setShowJudges] = useState(false);
  const [lastSeenMessageCount, setLastSeenMessageCount] = useState(0);

  // Chat history query (for unread badge)
  const { data: chatHistory } = useQuery({
    ...symphonyChatHistoryOptions(ticket.identifier, repoPath ?? ""),
    enabled: hasActiveSession,
    staleTime: 30_000,
  });
  const currentMessageCount = chatHistory?.messages?.length || 0;
  const hasUnreadMessages = currentMessageCount > lastSeenMessageCount;

  const handleCloseChat = useCallback(() => {
    setShowChat(false);
    setChatInitialTab(undefined);
    setLastSeenMessageCount(currentMessageCount);
  }, [currentMessageCount]);

  const openChatTab = useCallback((tab?: LeftPaneTab) => {
    setChatInitialTab(tab);
    setShowChat(true);
  }, []);

  // Logs query (enabled when dialog is open and session is active)
  const { data: logs } = useQuery({
    ...symphonyLogsOptions(ticket.identifier, repoPath ?? ""),
    enabled: showLogs && hasActiveSession,
    refetchInterval: showLogs ? 2000 : false,
  });

  // Overflow menu items visibility
  const isSymphonyActive = isExecuting || isLaunchingOrAccepting;
  const showCodexReview =
    !!codexAvailable &&
    !!onCodexReview &&
    (isCompleted || hasPushed || !!prInfo) &&
    !isSymphonyActive;
  const showDeploy =
    (isCompleted || hasPushed || !!prInfo) &&
    !!onDeploy &&
    !deployInfo &&
    !isSymphonyActive;
  const showResumeExecution =
    !!onResumeExecution && isCompleted && !hasPushed && !isSymphonyActive;
  const hasPostActionItems =
    showCodexReview || showDeploy || showResumeExecution;
  const hasOverflowItems = hasActiveSession || hasPostActionItems;

  return (
    <div className="relative h-[420px] overflow-hidden rounded-xl border border-border">
      {/* Action buttons - show when there's an active session */}
      {hasActiveSession && (
        <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5">
          {/* Chat button */}
          <button
            className={cn(
              ACTION_BUTTON_BASE,
              "hover:border-blue-500/30 hover:text-blue-500"
            )}
            onClick={() => openChatTab()}
            title="Chat"
          >
            <MessageSquare className="size-3.5" />
            {hasUnreadMessages && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full border-2 border-card bg-emerald-400" />
            )}
          </button>

          {/* Changes button */}
          {(isCompleted || isAwaitingUser) && (
            <button
              className={cn(
                ACTION_BUTTON_BASE,
                "hover:border-violet-500/30 hover:text-violet-500"
              )}
              onClick={() => openChatTab("changes")}
              title="Changes"
            >
              <GitBranch className="size-3.5" />
            </button>
          )}

          {/* PR Comments button */}
          {(isCompleted || isAwaitingUser) && prInfo && (
            <button
              className={cn(
                ACTION_BUTTON_BASE,
                "hover:border-amber-500/30 hover:text-amber-500"
              )}
              onClick={() => openChatTab("comments")}
              title="PR Comments"
            >
              <MessagesSquare className="size-3.5" />
            </button>
          )}

          {/* Overflow menu */}
          {hasOverflowItems && (
            <OverflowMenu
              codexReviewRunning={codexReviewRunning}
              hasPostActionItems={hasPostActionItems}
              isDeploying={isDeploying}
              isResuming={isResuming}
              onClose={onClose}
              onCodexReview={onCodexReview}
              onDeploy={onDeploy}
              onResumeExecution={onResumeExecution}
              planAcceptedKey={planAcceptedKey}
              setShowJudges={setShowJudges}
              setShowLogs={setShowLogs}
              showCodexReview={showCodexReview}
              showDeploy={showDeploy}
              showResumeExecution={showResumeExecution}
              ticketId={ticket.identifier}
            />
          )}
        </div>
      )}

      {/* Ticket Card */}
      <TicketCard
        branchMerged={branchMerged}
        childTicketIds={childTicketIds}
        codexAvailable={codexAvailable}
        codexReviewRunning={codexReviewRunning}
        deployInfo={deployInfo}
        hasPushed={hasPushed}
        hasWorkDirectory={hasWorkDirectory}
        isCreatingPR={isCreatingPR}
        isDeployable={isDeployable}
        isDeploying={isDeploying}
        isLaunching={isLaunchingOrAccepting}
        isResuming={isResuming}
        isRunning={isExecuting}
        onCodexReview={onCodexReview}
        onCommitPush={onCommitPush}
        onCreatePR={
          onCreatePR && repoPath
            ? () => onCreatePR(ticket.identifier, repoPath)
            : undefined
        }
        onDeploy={onDeploy}
        onLearningsClick={onLearningsClick}
        onParentClick={onParentClick}
        onResumeExecution={onResumeExecution}
        onStopSymphony={onStopSymphony}
        onTeardown={onTeardown}
        parentTicketId={parentTicketId}
        pendingClaudeMdPath={pendingClaudeMdPath}
        prInfo={prInfo}
        repoPath={repoPath}
        symphonyAwaitingUser={isAwaitingUser}
        symphonyCompleted={isCompleted}
        symphonyExecuting={isCoding}
        symphonyStopped={isStopped}
        taskProgress={symphonyStatus?.taskProgress}
        ticket={ticket}
      />

      {/* Vertical "Plan" tab on right edge */}
      {hasActiveSession && hasPlan && !isPlanOpen && (
        <button
          className={cn(
            "absolute top-1/2 right-0 z-10 -translate-y-1/2",
            "flex cursor-pointer items-center justify-center",
            "rounded-l-lg px-1.5 py-4",
            "border border-border border-r-0 bg-card/90 shadow-sm backdrop-blur-sm",
            "text-muted-foreground hover:border-accent hover:bg-accent hover:text-primary",
            "transition-all duration-200"
          )}
          onClick={() => setIsPlanOpen(true)}
          title="View plan"
        >
          <span
            className="font-medium text-xs uppercase tracking-wider"
            style={{ writingMode: "vertical-rl" }}
          >
            Plan
          </span>
        </button>
      )}

      {/* Sliding plan panel */}
      <div
        className={cn(
          "absolute inset-0 z-10 overflow-hidden",
          "transform-gpu transition-transform duration-300 ease-out",
          isPlanOpen ? "translate-x-0" : "pointer-events-none translate-x-full"
        )}
      >
        {/* Vertical "Close" tab on left edge of panel */}
        {isPlanOpen && (
          <button
            className={cn(
              "absolute top-1/2 left-0 z-10 -translate-y-1/2",
              "flex cursor-pointer items-center justify-center",
              "rounded-r-lg px-1.5 py-4",
              "border border-border border-l-0 bg-card/90 shadow-sm backdrop-blur-sm",
              "text-muted-foreground hover:border-accent hover:bg-accent hover:text-primary",
              "transition-all duration-200"
            )}
            onClick={() => setIsPlanOpen(false)}
            title="Close plan"
          >
            <span
              className="font-medium text-xs uppercase tracking-wider"
              style={{ writingMode: "vertical-rl" }}
            >
              Close
            </span>
          </button>
        )}

        {hasActiveSession && (
          <div className="card-editorial flex h-full flex-col rounded-xl py-5 pr-5 pb-10 pl-8 sm:py-6 sm:pr-6 sm:pb-12 sm:pl-9">
            <a
              className="group mb-3 inline-flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs transition-colors hover:text-primary"
              href={ticket.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {ticket.identifier}
              <ExternalLink className="size-3 -translate-y-0.5 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100" />
            </a>
            <PlanViewer
              renderAction={() => {
                // Show Accept Plan & Continue when awaiting user review (plan exists but not yet accepted)
                if (onResume && !isCompleted && !isCoding) {
                  return (
                    <Button
                      className="w-full"
                      disabled={isLaunchingOrAccepting || isExecuting}
                      onClick={() => {
                        setIsAcceptingPlan(true);
                        setHasPlanAccepted(true);
                        localStorage.setItem(planAcceptedKey, "true");
                        onResume();
                      }}
                      size="lg"
                    >
                      <ButtonLabel
                        isExecuting={isExecuting}
                        isLaunching={isLaunchingOrAccepting}
                      />
                    </Button>
                  );
                }
                return null;
              }}
              repoPath={repoPath}
              ticketId={ticket.identifier}
            />
          </div>
        )}
      </div>

      {/* Chat dialog */}
      {repoPath && (
        <SymphonyChat
          contextRepoPaths={contextRepoPaths}
          initialTab={chatInitialTab}
          isOpen={showChat}
          onClose={handleCloseChat}
          prInfo={prInfo}
          repoPath={repoPath}
          ticketId={ticket.identifier}
          ticketTitle={ticket.title}
        />
      )}

      {/* Logs dialog */}
      <LogViewer
        isOpen={showLogs}
        logs={logs}
        onClose={() => setShowLogs(false)}
      />

      {/* Judges dialog */}
      {repoPath && (
        <JudgesViewer
          isOpen={showJudges}
          onClose={() => setShowJudges(false)}
          repoPath={repoPath}
          ticketId={ticket.identifier}
        />
      )}
    </div>
  );
}

const ACTION_BUTTON_BASE = cn(
  "relative flex size-7 cursor-pointer items-center justify-center rounded-full",
  "border border-border bg-card/90 shadow-sm backdrop-blur-sm",
  "text-muted-foreground transition-all duration-200 hover:scale-110"
);

/** Overflow dropdown extracted to reduce cognitive complexity of the main component. */
function OverflowMenu({
  hasPostActionItems,
  showCodexReview,
  codexReviewRunning,
  showResumeExecution,
  isResuming,
  showDeploy,
  isDeploying,
  ticketId,
  setShowLogs,
  setShowJudges,
  onCodexReview,
  onResumeExecution,
  onDeploy,
  onClose,
  planAcceptedKey,
}: Readonly<{
  hasPostActionItems: boolean;
  showCodexReview: boolean;
  codexReviewRunning?: boolean;
  showResumeExecution: boolean;
  isResuming?: boolean;
  showDeploy: boolean;
  isDeploying?: boolean;
  ticketId: string;
  setShowLogs: (v: boolean) => void;
  setShowJudges: (v: boolean) => void;
  onCodexReview?: (ticketId: string) => void;
  onResumeExecution?: (ticketId: string) => void;
  onDeploy?: (ticketId: string) => void;
  onClose?: () => void;
  planAcceptedKey: string;
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            ACTION_BUTTON_BASE,
            "hover:border-primary/30 hover:text-primary"
          )}
          title="More actions"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setShowLogs(true)}>
          <Terminal className="size-4" />
          Logs
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setShowJudges(true)}>
          <Scale className="size-4" />
          Judges
        </DropdownMenuItem>
        {hasPostActionItems && <DropdownMenuSeparator />}
        {showCodexReview && onCodexReview && (
          <DropdownMenuItem onClick={() => onCodexReview(ticketId)}>
            <ScanEye className="size-4" />
            {codexReviewRunning ? "Review in progress..." : "Codex Review"}
          </DropdownMenuItem>
        )}
        {showResumeExecution && onResumeExecution && (
          <DropdownMenuItem
            disabled={isResuming}
            onClick={() => onResumeExecution(ticketId)}
          >
            <RotateCcw className="size-4" />
            Resume Execution
          </DropdownMenuItem>
        )}
        {showDeploy && onDeploy && (
          <DropdownMenuItem
            disabled={isDeploying}
            onClick={() => onDeploy(ticketId)}
          >
            <Rocket className="size-4" />
            {isDeploying ? "Deploying..." : "Deploy"}
          </DropdownMenuItem>
        )}
        {onClose && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                localStorage.removeItem(planAcceptedKey);
                onClose();
              }}
            >
              <X className="size-4" />
              Remove from active work
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
