import type * as EligibilityModule from "../../src/main/branch/shared-branches-default-eligibility.js";

type Module = typeof EligibilityModule;

/**
 * Desktop never has a repository-default authority, so production snapshots are
 * non-authoritative and the usage and analytics reads refuse a cohort total.
 * Suites that test the PROJECTION behind those totals mock the resolver with
 * this wrapper to reach it; the gate itself is pinned in
 * `branch-default-eligibility-not-connected.test.ts`.
 */
export function withCompleteEligibility(original: Module): Module {
  return {
    ...original,
    resolveBranchProductEligibilitySnapshot: (rows) => ({
      ...original.resolveBranchProductEligibilitySnapshot(rows),
      authoritative: true,
      coverageComplete: true,
      pullRequestCoverageComplete: true,
      diagnostic: undefined,
    }),
  };
}
