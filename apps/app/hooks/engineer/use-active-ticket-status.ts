"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { symphonyStatusOptions } from "@/lib/engineer/queries/symphony";

type UseActiveTicketStatusInput = {
  ticketId: string;
  repoPath: string | null;
  isLaunching: boolean;
  isResuming?: boolean;
};

export type ActiveTicketStatus = {
  /** Raw status string from the poll (e.g. "AWAITING_USER", "IN_PROGRESS") */
  statusValue: string | null;
  isExecuting: boolean;
  isCompleted: boolean;
  isStopped: boolean;
  isAwaitingUser: boolean;
  /** True only when the user has explicitly accepted the plan */
  isCoding: boolean;
  /** True while the launch API has returned but no status poll has arrived yet */
  isWaitingForSymphony: boolean;
  /** Composite: launching, accepting plan, waiting for first status, or resuming */
  isLaunchingOrAccepting: boolean;
  isAcceptingPlan: boolean;
  setIsAcceptingPlan: (value: boolean) => void;
  hasPlanAccepted: boolean;
  setHasPlanAccepted: (value: boolean) => void;
  taskProgress?: { pending: number; completed: number; total: number };
};

/**
 * Derives symphony execution state from the status polling query.
 *
 * Extracted from ActiveTicketCard so the logic is independently testable.
 * The `isWaitingForSymphony` flag latches off once a valid status has been
 * received, preventing transient poll failures (common in CloudRelay) from
 * flashing the "Launching" indicator on idle tickets.
 */
export function useActiveTicketStatus({
  ticketId,
  repoPath,
  isLaunching,
  isResuming,
}: UseActiveTicketStatusInput): ActiveTicketStatus {
  const [isAcceptingPlan, setIsAcceptingPlan] = useState(false);

  // Persisted in localStorage so it survives page refreshes and stop/resume cycles.
  const planAcceptedKey = `plan-accepted:${ticketId}`;
  const [hasPlanAccepted, setHasPlanAccepted] = useState(() => {
    if (globalThis.window === undefined) {
      return false;
    }
    return localStorage.getItem(planAcceptedKey) === "true";
  });

  // Poll Symphony status every 3 seconds
  const { data: symphonyStatus } = useQuery({
    ...symphonyStatusOptions(ticketId, repoPath),
    refetchInterval: 3000,
  });

  const statusValue = symphonyStatus?.status ?? null;
  const isExecuting = statusValue === "IN_PROGRESS";
  const isCompleted = statusValue === "COMPLETED";
  const isStopped = statusValue === "STOPPED";
  const isAwaitingUser = statusValue === "AWAITING_USER";
  const isCoding = isExecuting && hasPlanAccepted;

  // Clear "accepting plan" state once Symphony starts executing, completes, or awaits user
  useEffect(() => {
    if (isExecuting || isCompleted || isAwaitingUser) {
      setIsAcceptingPlan(false);
    }
  }, [isExecuting, isCompleted, isAwaitingUser]);

  // Track whether we've ever received a valid status for this launch cycle.
  // Once true, transient poll failures (common in CloudRelay) won't
  // flash the "Launching" indicator.
  // Reset on session boundary changes (repoPath) and when a new launch or
  // resume begins on the same instance so the latch doesn't carry over.
  const hasReceivedStatus = useRef(false);
  const prevRepoPath = useRef(repoPath);
  const prevIsLaunching = useRef(isLaunching);
  const prevIsResuming = useRef(!!isResuming);
  if (prevRepoPath.current !== repoPath) {
    prevRepoPath.current = repoPath;
    hasReceivedStatus.current = false;
  }
  if (
    (isLaunching && !prevIsLaunching.current) ||
    (!!isResuming && !prevIsResuming.current)
  ) {
    hasReceivedStatus.current = false;
  }
  prevIsLaunching.current = isLaunching;
  prevIsResuming.current = !!isResuming;
  if (statusValue) {
    hasReceivedStatus.current = true;
  }

  // Show launching state only in the gap between launch API returning and
  // Symphony's first status poll — never after we've seen a valid status.
  const isWaitingForSymphony =
    !!repoPath && !statusValue && !hasReceivedStatus.current;

  const isLaunchingOrAccepting =
    isLaunching || isAcceptingPlan || isWaitingForSymphony || !!isResuming;

  const persistPlanAccepted = useCallback(
    (value: boolean) => {
      setHasPlanAccepted(value);
      if (value) {
        localStorage.setItem(planAcceptedKey, "true");
      } else {
        localStorage.removeItem(planAcceptedKey);
      }
    },
    [planAcceptedKey]
  );

  return {
    statusValue,
    isExecuting,
    isCompleted,
    isStopped,
    isAwaitingUser,
    isCoding,
    isWaitingForSymphony,
    isLaunchingOrAccepting,
    isAcceptingPlan,
    setIsAcceptingPlan,
    hasPlanAccepted,
    setHasPlanAccepted: persistPlanAccepted,
    taskProgress: symphonyStatus?.taskProgress,
  };
}
