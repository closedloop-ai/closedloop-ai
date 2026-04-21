"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle,
  Clock,
  Loader2,
  Pause,
  Play,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { symphonyStatusOptions } from "@/lib/engineer/queries/symphony";

type SymphonyStatusProps = {
  ticketId: string;
  repoPath: string;
  onStop?: () => void;
  onResume?: () => void;
};

/**
 * Format elapsed seconds as hh:mm:ss
 */
function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Live timer that ticks every second from a given start time.
 */
function AgentTimer({ startedAt }: Readonly<{ startedAt: string }>) {
  const [elapsed, setElapsed] = useState(() => {
    const start = new Date(startedAt).getTime();
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
  });

  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span className="tabular-nums opacity-60">{formatElapsed(elapsed)}</span>
  );
}

/**
 * Get status icon based on current status
 */
function getStatusIcon(status: string | null | undefined) {
  switch (status) {
    case "COMPLETED":
      return (
        <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      );
    case "ERROR":
    case "FAILED":
      return <AlertCircle className="h-4 w-4 text-destructive" />;
    case "STOPPED":
      return (
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      );
    case "WAITING":
    case "PAUSED":
      return <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
    default:
      return (
        <Loader2 className="h-4 w-4 animate-spin text-sky-600 dark:text-sky-400" />
      );
  }
}

/**
 * Get status color classes
 */
function getStatusColor(status: string | null | undefined) {
  switch (status) {
    case "COMPLETED":
      return "bg-emerald-500/10 border-emerald-500/20 text-emerald-800 dark:text-emerald-300";
    case "ERROR":
    case "FAILED":
      return "bg-destructive/10 border-destructive/20 text-destructive";
    case "STOPPED":
      return "bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-300";
    case "WAITING":
    case "PAUSED":
      return "bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-300";
    default:
      return "bg-sky-100 border-sky-400 text-sky-900 dark:bg-sky-500/10 dark:border-sky-500/20 dark:text-sky-300";
  }
}

/**
 * SymphonyStatus component displays real-time Symphony execution status.
 * Polls state.json every 2 seconds for updates.
 */
export function SymphonyStatus({
  ticketId,
  repoPath,
  onStop,
  onResume,
}: Readonly<SymphonyStatusProps>) {
  const [resumeClicked, setResumeClicked] = useState(false);
  const [prevStatus, setPrevStatus] = useState<string | null | undefined>(
    undefined
  );
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: status, isLoading } = useQuery({
    ...symphonyStatusOptions(ticketId, repoPath),
    // Poll every 2 seconds while running, or while waiting for resume to take effect
    refetchInterval: (query) => {
      if (resumeClicked) {
        return 2000;
      }
      const data = query.state.data;
      if (
        data?.status === "COMPLETED" ||
        data?.status === "ERROR" ||
        data?.status === "STOPPED"
      ) {
        return false; // Stop polling when done
      }
      return 2000; // Poll every 2 seconds
    },
    retry: false,
  });

  // Clear resumeClicked when status transitions away from STOPPED (React-recommended
  // pattern for adjusting state based on changed data during render)
  if (status?.status !== prevStatus) {
    setPrevStatus(status?.status);
    if (resumeClicked && status?.status !== "STOPPED") {
      setResumeClicked(false);
    }
  }

  // Safety timeout: if resume doesn't take effect within 10 seconds, allow retry
  useEffect(() => {
    if (resumeClicked) {
      resumeTimerRef.current = setTimeout(() => {
        setResumeClicked(false);
      }, 10_000);
    }
    return () => {
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
  }, [resumeClicked]);

  const isResuming = resumeClicked && status?.status === "STOPPED";

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading status...</span>
      </div>
    );
  }

  if (!status?.exists) {
    return null;
  }

  const agents = status.activeAgents ?? [];
  const hasActiveAgents = agents.length > 0;
  // Show stop button when status is IN_PROGRESS or STARTING, regardless of whether we have a PID
  const isInProgress =
    status.status === "IN_PROGRESS" || status.status === "STARTING";
  const canStop = isInProgress && onStop;
  const canResume = status.status === "STOPPED" && onResume && !isResuming;

  // Override display when resuming; show live activity during STARTING phase
  const displayStatus = isResuming ? "STARTING" : status.status;
  const showLiveActivity =
    !isResuming &&
    (status.status === "STARTING" || status.stateExists === false) &&
    !!status.liveActivity;
  let displayPhase = status.phase || "Initializing...";
  if (isResuming) {
    displayPhase = "Resuming...";
  } else if (showLiveActivity) {
    displayPhase = status.liveActivity ?? "Initializing...";
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2 text-sm",
        getStatusColor(displayStatus)
      )}
    >
      {getStatusIcon(displayStatus)}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {displayPhase}
          {!isResuming && status.currentTaskId && (
            <span className="ml-1.5 font-normal opacity-60">
              ({status.currentTaskId})
            </span>
          )}
        </p>
        {hasActiveAgents ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {agents.slice(0, 3).map((agent) => (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-100 px-1.5 py-0.5 font-mono text-[11px] text-violet-800 leading-tight dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300"
                key={agent.agentId}
              >
                <Bot className="size-2.5 shrink-0 opacity-60" />
                {agent.agentName}
                {agent.startedAt && (
                  <>
                    <span className="opacity-40">·</span>
                    <AgentTimer startedAt={agent.startedAt} />
                  </>
                )}
              </span>
            ))}
            {agents.length > 3 && (
              <span className="font-mono text-[11px] opacity-60">
                +{agents.length - 3} more
              </span>
            )}
          </div>
        ) : (
          !isResuming &&
          status.status &&
          status.status !== "COMPLETED" &&
          status.status !== "IN_PROGRESS" && (
            <p className="text-xs opacity-75">{status.status}</p>
          )
        )}
      </div>
      {canStop && (
        <button
          className="cursor-pointer self-center rounded-md p-1.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          title="Pause execution"
          type="button"
        >
          <Pause className="size-4 fill-current" />
        </button>
      )}
      {canResume && (
        <button
          className="cursor-pointer self-center rounded-md p-1.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            setResumeClicked(true);
            onResume();
          }}
          title="Resume execution"
          type="button"
        >
          <Play className="size-4 fill-current" />
        </button>
      )}
    </div>
  );
}
