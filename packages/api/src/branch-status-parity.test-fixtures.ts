import { GitHubPRState } from "./types/github-status.ts";

/**
 * ISS-9664 — the cross-surface branch-status contract, as PR evidence in and a
 * status word out.
 *
 * Two producers derive a branch's status from the same evidence: the cloud read
 * (`statusForSelectedCloudPullRequest`, `apps/api/app/branches`) and the desktop
 * producer (`statusForSelectedDesktopPullRequest`, `apps/desktop/src/main`).
 * They diverged — the no-evidence branch derived Open on web and Draft on
 * desktop, and a closed draft derived Closed on desktop and Draft on web — so
 * this table is the shared oracle both surfaces answer to. Each surface owns a
 * test that walks these cases through its OWN wrapper, so a surface that drifts
 * fails its own suite instead of silently disagreeing with the other one.
 *
 * `expected` is a bare string literal ON PURPOSE. Reading it from `BranchStatus`
 * would make the fixture agree with whatever that const currently says, so a
 * renamed or deleted member would keep this table green while every rendered
 * word changed. The duplication IS the test.
 */
export const BranchStatusEvidence = {
  /** No pull request is connected to the branch at all. */
  None: "none",
  /**
   * A PR is connected but NO producer ever observed its lifecycle (ISS-8422).
   * `prState` on such a row is the column's `@default(OPEN)`, not a reading, so
   * every surface must derive it exactly as it derives {@link None}.
   */
  Unobserved: "unobserved",
  /** A PR whose lifecycle state was actually measured. */
  Observed: "observed",
} as const;
export type BranchStatusEvidence =
  (typeof BranchStatusEvidence)[keyof typeof BranchStatusEvidence];

export type BranchStatusParityCase = {
  readonly name: string;
  readonly evidence: BranchStatusEvidence;
  /** The PR row's `prState` column — a reading only when `evidence` is Observed. */
  readonly prState: GitHubPRState | null;
  /** GitHub's draft flag on the connected PR row. */
  readonly isDraft: boolean;
  /** The exact `BranchStatus` wire value both surfaces must render. */
  readonly expected: string;
};

export const BRANCH_STATUS_PARITY_CASES: readonly BranchStatusParityCase[] = [
  {
    name: "a branch with no PR at all is Open, not Draft",
    evidence: BranchStatusEvidence.None,
    prState: null,
    isDraft: false,
    expected: "open",
  },
  {
    name: "an unobserved PR derives the same Open a PR-less branch derives",
    evidence: BranchStatusEvidence.Unobserved,
    prState: GitHubPRState.Open,
    isDraft: true,
    expected: "open",
  },
  {
    name: "an observed open non-draft PR is Open",
    evidence: BranchStatusEvidence.Observed,
    prState: GitHubPRState.Open,
    isDraft: false,
    expected: "open",
  },
  {
    name: "an observed open draft PR is Draft",
    evidence: BranchStatusEvidence.Observed,
    prState: GitHubPRState.Open,
    isDraft: true,
    expected: "draft",
  },
  {
    name: "an observed merged PR is Merged",
    evidence: BranchStatusEvidence.Observed,
    prState: GitHubPRState.Merged,
    isDraft: false,
    expected: "merged",
  },
  {
    name: "merge evidence beats a stale draft flag (FEA-4333)",
    evidence: BranchStatusEvidence.Observed,
    prState: GitHubPRState.Merged,
    isDraft: true,
    expected: "merged",
  },
  {
    name: "an observed closed non-draft PR is Closed",
    evidence: BranchStatusEvidence.Observed,
    prState: GitHubPRState.Closed,
    isDraft: false,
    expected: "closed",
  },
  {
    name: "a closed DRAFT PR is Draft on both surfaces, not Closed",
    evidence: BranchStatusEvidence.Observed,
    prState: GitHubPRState.Closed,
    isDraft: true,
    expected: "draft",
  },
];
