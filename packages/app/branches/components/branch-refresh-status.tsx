"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect } from "react";

export const BranchRefreshState = {
  Idle: "idle",
  Pending: "pending",
  Success: "success",
  Error: "error",
} as const;
export type BranchRefreshState =
  (typeof BranchRefreshState)[keyof typeof BranchRefreshState];

export const BRANCH_REFRESH_STATUS_VISIBLE_MS = 2500;

type BranchRefreshStatusProps = {
  state: BranchRefreshState;
  subject: "branch data" | "branch detail";
  className?: string;
};

/** Shared manual-refresh status banner for the Branches list and detail pages. */
export function BranchRefreshStatus({
  state,
  subject,
  className,
}: BranchRefreshStatusProps): ReactNode {
  if (state === BranchRefreshState.Idle) {
    return null;
  }
  const isError = state === BranchRefreshState.Error;
  const classes = [
    isError
      ? "rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)] text-xs"
      : "rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-[var(--muted-foreground)] text-xs",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes}>{refreshStatusText(state, subject)}</div>;
}

/** Clears terminal manual-refresh banners after a short visible confirmation. */
export function useAutoClearBranchRefreshState(
  state: BranchRefreshState,
  setState: Dispatch<SetStateAction<BranchRefreshState>>,
  delayMs = BRANCH_REFRESH_STATUS_VISIBLE_MS
) {
  useEffect(() => {
    if (
      state === BranchRefreshState.Idle ||
      state === BranchRefreshState.Pending
    ) {
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      setState(BranchRefreshState.Idle);
    }, delayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [delayMs, setState, state]);
}

function refreshStatusText(
  state: BranchRefreshState,
  subject: BranchRefreshStatusProps["subject"]
): string {
  if (state === BranchRefreshState.Pending) {
    return `Refreshing ${subject}…`;
  }
  const sentenceSubject = `${subject[0].toUpperCase()}${subject.slice(1)}`;
  if (state === BranchRefreshState.Success) {
    return `${sentenceSubject} refreshed.`;
  }
  if (subject === "branch data") {
    return "Branch refresh failed. Retry from the Refresh button.";
  }
  return `${sentenceSubject} refresh failed. Retry from the Refresh button.`;
}
