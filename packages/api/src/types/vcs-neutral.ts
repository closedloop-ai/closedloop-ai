/**
 * Provider-neutral VCS enums + exhaustive mappers to/from the GitHub-specific
 * Prisma enums (FEA-3874, parent FEA-3801, PLN-1457 Slice 2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Phase 1 of git-provider neutrality is **additive and behavior-preserving**.
 * The stored rows keep their GitHub-specific enums (`GitHubPRState`,
 * `ChecksStatus`, Prisma `ReviewDecision`, `GitHubInstallationStatus`); nothing
 * is migrated to these neutral values in this slice. These const-objects are the
 * single source of truth for the *neutral* vocabulary that later slices (and any
 * future non-GitHub provider) read/write, plus the mappers that translate
 * between the neutral shape and the GitHub shape at the seam.
 *
 * Every mapper is EXHAUSTIVE with a compile-time `never` guard in its `default`
 * branch: adding a new variant to either the neutral enum or the GitHub enum
 * fails `tsc` until the mapper is updated. This is the mechanism the plan's AC
 * calls for ("adding a state fails `tsc`").
 *
 * This module has NO relative VALUE imports and no runtime dependencies beyond
 * the leaf GitHub enum modules it mirrors, so it is safe to import from both the
 * `apps/app`/`apps/api` bundler programs and the desktop `nodenext` program
 * (same constraint documented on `branch-checks.ts`). It imports the GitHub enum
 * const-objects with explicit `.js` extensions for that reason.
 */

import {
  ChecksStatus as GitHubChecksStatus,
  ReviewDecision as GitHubReviewDecision,
} from "./branch-checks.js";
import { GitHubInstallationStatus } from "./github.js";
import { GitHubPRState } from "./github-status.js";
import { VcsProviderKind as VcsProviderKindLeaf } from "./vcs-provider-kind.js";

// ---------------------------------------------------------------------------
// Provider kind (neutral SSOT)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral VCS host identifier. Sourced from its own lightweight leaf
 * (`vcs-provider-kind.ts`) so bundle-sensitive consumers can import the
 * identifier without pulling in the neutral mappers below, while both surfaces
 * share ONE const. (Imported then re-declared rather than `export … from` to
 * avoid Biome's `noBarrelFile` heuristic while keeping the const identity
 * shared.)
 */
export const VcsProviderKind = VcsProviderKindLeaf;
export type VcsProviderKind = VcsProviderKindLeaf;

// ---------------------------------------------------------------------------
// Neutral enums (const-object SSOT, mirroring the Prisma enum wire values)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral lifecycle state of a change request (GitHub pull request,
 * GitLab merge request, Azure DevOps pull request).
 *
 * Superset of `GitHubPRState`: adds `LOCKED`, which GitHub models as an
 * orthogonal `locked` flag rather than a distinct PR state but which GitLab and
 * Azure expose as a first-class MR/PR state. GitHub rows never carry `LOCKED`
 * today; the neutral→GitHub mapper folds it onto `CLOSED` (a locked change
 * request is not open for new work) so the mapping stays total and no GitHub
 * write path can be handed an unrepresentable value.
 */
export const ChangeRequestState = {
  Open: "OPEN",
  Merged: "MERGED",
  Closed: "CLOSED",
  Locked: "LOCKED",
} as const;
export type ChangeRequestState =
  (typeof ChangeRequestState)[keyof typeof ChangeRequestState];

/**
 * Provider-neutral CI/check rollup status. Value set is identical to the GitHub
 * `ChecksStatus` in Phase 1; kept as a distinct neutral type so later providers
 * map their own check taxonomies onto it without widening the stored GitHub
 * enum.
 */
export const VcsCheckStatus = {
  Unknown: "UNKNOWN",
  Pending: "PENDING",
  Passing: "PASSING",
  Failing: "FAILING",
} as const;
export type VcsCheckStatus =
  (typeof VcsCheckStatus)[keyof typeof VcsCheckStatus];

/**
 * Provider-neutral review decision. Value set matches the GitHub
 * `ReviewDecision` in Phase 1 (per PLN-1457 Open Question 4: keep the GitHub set
 * now, widen the mapper — not the stored rows — when GitLab approvals / Azure
 * votes arrive in Phase 2).
 */
export const VcsReviewDecision = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Commented: "COMMENTED",
  Dismissed: "DISMISSED",
} as const;
export type VcsReviewDecision =
  (typeof VcsReviewDecision)[keyof typeof VcsReviewDecision];

/**
 * Provider-neutral connection/auth status, generalizing
 * `GitHubInstallationStatus`. Value set is identical in Phase 1; the neutral
 * name lets the `VcsConnection` projection (Slice 3) and future non-App auth
 * kinds (PAT/OAuth) share one status vocabulary.
 */
export const VcsConnectionStatus = {
  PendingClaim: "PENDING_CLAIM",
  Active: "ACTIVE",
  Suspended: "SUSPENDED",
  Uninstalled: "UNINSTALLED",
} as const;
export type VcsConnectionStatus =
  (typeof VcsConnectionStatus)[keyof typeof VcsConnectionStatus];

// ---------------------------------------------------------------------------
// Exhaustive mappers — ChangeRequestState <-> GitHubPRState
// ---------------------------------------------------------------------------

/**
 * GitHub PR state -> neutral change-request state. Total and lossless: every
 * `GitHubPRState` has a neutral counterpart.
 */
export function changeRequestStateFromGitHub(
  state: GitHubPRState
): ChangeRequestState {
  switch (state) {
    case GitHubPRState.Open:
      return ChangeRequestState.Open;
    case GitHubPRState.Merged:
      return ChangeRequestState.Merged;
    case GitHubPRState.Closed:
      return ChangeRequestState.Closed;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * Neutral change-request state -> GitHub PR state. Total: `LOCKED` (neutral-only)
 * folds onto `CLOSED` because GitHub has no distinct locked PR state. Keeps GitHub
 * writes representable without widening `GitHubPRState`.
 */
export function changeRequestStateToGitHub(
  state: ChangeRequestState
): GitHubPRState {
  switch (state) {
    case ChangeRequestState.Open:
      return GitHubPRState.Open;
    case ChangeRequestState.Merged:
      return GitHubPRState.Merged;
    case ChangeRequestState.Closed:
      return GitHubPRState.Closed;
    case ChangeRequestState.Locked:
      // GitHub has no LOCKED PR state; a locked change request is not open.
      return GitHubPRState.Closed;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Exhaustive mappers — VcsCheckStatus <-> ChecksStatus
// ---------------------------------------------------------------------------

export function vcsCheckStatusFromGitHub(
  status: GitHubChecksStatus
): VcsCheckStatus {
  switch (status) {
    case GitHubChecksStatus.Unknown:
      return VcsCheckStatus.Unknown;
    case GitHubChecksStatus.Pending:
      return VcsCheckStatus.Pending;
    case GitHubChecksStatus.Passing:
      return VcsCheckStatus.Passing;
    case GitHubChecksStatus.Failing:
      return VcsCheckStatus.Failing;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function vcsCheckStatusToGitHub(
  status: VcsCheckStatus
): GitHubChecksStatus {
  switch (status) {
    case VcsCheckStatus.Unknown:
      return GitHubChecksStatus.Unknown;
    case VcsCheckStatus.Pending:
      return GitHubChecksStatus.Pending;
    case VcsCheckStatus.Passing:
      return GitHubChecksStatus.Passing;
    case VcsCheckStatus.Failing:
      return GitHubChecksStatus.Failing;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Exhaustive mappers — VcsReviewDecision <-> ReviewDecision
// ---------------------------------------------------------------------------

export function vcsReviewDecisionFromGitHub(
  decision: GitHubReviewDecision
): VcsReviewDecision {
  switch (decision) {
    case GitHubReviewDecision.Approved:
      return VcsReviewDecision.Approved;
    case GitHubReviewDecision.ChangesRequested:
      return VcsReviewDecision.ChangesRequested;
    case GitHubReviewDecision.Commented:
      return VcsReviewDecision.Commented;
    case GitHubReviewDecision.Dismissed:
      return VcsReviewDecision.Dismissed;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

export function vcsReviewDecisionToGitHub(
  decision: VcsReviewDecision
): GitHubReviewDecision {
  switch (decision) {
    case VcsReviewDecision.Approved:
      return GitHubReviewDecision.Approved;
    case VcsReviewDecision.ChangesRequested:
      return GitHubReviewDecision.ChangesRequested;
    case VcsReviewDecision.Commented:
      return GitHubReviewDecision.Commented;
    case VcsReviewDecision.Dismissed:
      return GitHubReviewDecision.Dismissed;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Exhaustive mappers — VcsConnectionStatus <-> GitHubInstallationStatus
// ---------------------------------------------------------------------------

export function vcsConnectionStatusFromGitHub(
  status: GitHubInstallationStatus
): VcsConnectionStatus {
  switch (status) {
    case GitHubInstallationStatus.PendingClaim:
      return VcsConnectionStatus.PendingClaim;
    case GitHubInstallationStatus.Active:
      return VcsConnectionStatus.Active;
    case GitHubInstallationStatus.Suspended:
      return VcsConnectionStatus.Suspended;
    case GitHubInstallationStatus.Uninstalled:
      return VcsConnectionStatus.Uninstalled;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function vcsConnectionStatusToGitHub(
  status: VcsConnectionStatus
): GitHubInstallationStatus {
  switch (status) {
    case VcsConnectionStatus.PendingClaim:
      return GitHubInstallationStatus.PendingClaim;
    case VcsConnectionStatus.Active:
      return GitHubInstallationStatus.Active;
    case VcsConnectionStatus.Suspended:
      return GitHubInstallationStatus.Suspended;
    case VcsConnectionStatus.Uninstalled:
      return GitHubInstallationStatus.Uninstalled;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
