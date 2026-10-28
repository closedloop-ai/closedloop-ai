import { DocumentStatus, TERMINAL_ISSUE_STATUSES } from "./document.ts";
import { GitHubPRState } from "./github.ts";

/**
 * What the hide-completed table filter treats as completed, per artifact
 * vocabulary.
 *
 * Here rather than in `packages/app` because `apps/api` cannot import it
 * (ISS-10471). The rule decides WHAT A USER SEES, so a drifting second copy
 * would show one population and count another.
 */

/**
 * Deliberately NARROWER than the domain-wide `TERMINAL_DOCUMENT_STATUSES`,
 * which also contains `APPROVED`. An approved document awaits execution, so
 * hiding it would remove in-flight work from the board of whoever executes it.
 * The broad set stays correct for blocker semantics — which is why these two
 * must not be collapsed.
 */
export const HIDE_COMPLETED_DOCUMENT_STATUSES: readonly [
  DocumentStatus,
  ...DocumentStatus[],
] = Object.freeze([DocumentStatus.Executed, DocumentStatus.Obsolete] as const);

/**
 * The canonical issue terminal set itself, not a second spelling: an issue
 * lifecycle has no APPROVED-shaped "signed off but unfinished" state, so the
 * asymmetry above does not apply.
 */
const [firstTerminalIssueStatus, ...remainingTerminalIssueStatuses] = [
  ...TERMINAL_ISSUE_STATUSES,
];
if (firstTerminalIssueStatus === undefined) {
  // Emptying `ISSUE_STATUS_TERMINALITY` would otherwise surface as a
  // `Prisma.join([])` TypeError on every hide-completed request. Failing at
  // import names the cause instead.
  throw new Error(
    "TERMINAL_ISSUE_STATUSES is empty: hide-completed cannot build an IN list"
  );
}

/**
 * `string`, not `IssueStatus`, because its canonical owner in `@closedloop-ai/loops-api`
 * types the set that way; narrowing here would be this module asserting a
 * vocabulary it does not own.
 */
export const HIDE_COMPLETED_ISSUE_STATUSES: readonly [string, ...string[]] =
  Object.freeze([firstTerminalIssueStatus, ...remainingTerminalIssueStatuses]);

/**
 * Uppercase `GitHubPRState` while `Artifact.status` stores the branch
 * vocabulary lowercase (`BranchStatus`), so a caller matching against this list
 * has to normalize case first.
 */
export const HIDE_COMPLETED_BRANCH_STATUSES: readonly [
  GitHubPRState,
  ...GitHubPRState[],
] = Object.freeze([GitHubPRState.Merged, GitHubPRState.Closed] as const);
