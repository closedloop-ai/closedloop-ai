/**
 * Pure derivations for the branch PR status panel. No React, no fetch — the
 * single place that decides the lifecycle-badge text/tone so consumers never
 * fabricate values.
 *
 * PLN-1535 M5.3 removed the live `/pr/reviews` overlay that used to REFINE this
 * badge to "Approved"/"Changes requested". The badge is now derived purely from
 * the cloud-projected `status`/`prState`; a review decision the projection has
 * not recorded reads as the persisted lifecycle state rather than being guessed.
 */

import type { BranchPrState, BranchStatus } from "@repo/api/src/types/branch";
import { BranchStatus as BranchStatusEnum } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";

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

/**
 * Derive the lifecycle badge from the projected `status`/`prState`. Returns the
 * `gated` tone only when there is no projected state to read.
 */
export function deriveLifecycleBadge(input: {
  persisted: { prState: BranchPrState | null; status: BranchStatus | null };
}): LifecycleBadge {
  return persistedBadge(input.persisted);
}
