/**
 * Pure derivations for the F2 status overlay (Epic F / FEA-1952). No React, no
 * fetch — the single place that decides the lifecycle-badge text/tone so
 * consumers (the PR status panel) never fabricate values.
 */

import type { BranchPrState, BranchStatus } from "@repo/api/src/types/branch";
import { BranchStatus as BranchStatusEnum } from "@repo/api/src/types/branch";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { LivePrStatusResult } from "./live-pr-status";

export const LifecycleTone = {
  Open: "open",
  Review: "review",
  Merged: "merged",
  Draft: "draft",
  Blocked: "blocked",
  Closed: "closed",
  /** Not connected AND no persisted state to fall back to. */
  Gated: "gated",
} as const;
export type LifecycleTone = (typeof LifecycleTone)[keyof typeof LifecycleTone];

export type LifecycleBadge = { label: string; tone: LifecycleTone };

const STATUS_BADGE: Record<BranchStatus, LifecycleBadge> = {
  [BranchStatusEnum.Open]: { label: "Open", tone: LifecycleTone.Open },
  [BranchStatusEnum.Review]: { label: "In review", tone: LifecycleTone.Review },
  [BranchStatusEnum.Merged]: { label: "Merged", tone: LifecycleTone.Merged },
  [BranchStatusEnum.Draft]: { label: "Draft", tone: LifecycleTone.Draft },
  [BranchStatusEnum.Blocked]: { label: "Blocked", tone: LifecycleTone.Blocked },
  [BranchStatusEnum.Closed]: { label: "Closed", tone: LifecycleTone.Closed },
};

function persistedBadge(persisted: {
  prState: BranchPrState | null;
  status: BranchStatus | null;
}): LifecycleBadge {
  if (persisted.status) {
    return STATUS_BADGE[persisted.status];
  }
  if (persisted.prState === GitHubPRState.Merged) {
    return { label: "Merged", tone: LifecycleTone.Merged };
  }
  if (persisted.prState === GitHubPRState.Closed) {
    return { label: "Closed", tone: LifecycleTone.Closed };
  }
  if (persisted.prState === GitHubPRState.Open) {
    return { label: "Open", tone: LifecycleTone.Open };
  }
  return { label: "Status unavailable", tone: LifecycleTone.Gated };
}

function isClosedOut(persisted: {
  prState: BranchPrState | null;
  status: BranchStatus | null;
}): boolean {
  return (
    persisted.status === BranchStatusEnum.Merged ||
    persisted.status === BranchStatusEnum.Closed ||
    persisted.prState === GitHubPRState.Merged ||
    persisted.prState === GitHubPRState.Closed
  );
}

/**
 * Live review decision REFINES the badge; otherwise fall back to persisted
 * `status`/`prState`. Returns the `gated` tone only when there is no live data
 * AND no persisted state to fall back to.
 */
export function deriveLifecycleBadge(input: {
  persisted: { prState: BranchPrState | null; status: BranchStatus | null };
  live: LivePrStatusResult | null;
}): LifecycleBadge {
  const { persisted, live } = input;
  if (live) {
    if (live.reviewDecision === ReviewDecision.ChangesRequested) {
      return { label: "Changes requested", tone: LifecycleTone.Blocked };
    }
    if (
      live.reviewDecision === ReviewDecision.Approved &&
      !isClosedOut(persisted)
    ) {
      return { label: "Approved", tone: LifecycleTone.Review };
    }
  }
  return persistedBadge(persisted);
}
