import {
  BRANCH_STATUS_PARITY_CASES,
  BranchStatusEvidence,
  type BranchStatusParityCase,
} from "@repo/api/src/branch-status-parity.test-fixtures";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { statusForSelectedCloudPullRequest } from "./branch-associated-pull-request-projection";

/**
 * ISS-9664 — the CLOUD half of the cross-surface branch-status contract. The
 * desktop half walks the same table through its own producer in
 * `apps/desktop/test/branch-associated-pull-request-projection.test.ts`; the two
 * cannot be one test because neither app can import the other, so the shared
 * fixture is what holds them together. Drift on this surface fails here.
 */
describe("branch status parity (cloud producer)", () => {
  for (const parityCase of BRANCH_STATUS_PARITY_CASES) {
    it(parityCase.name, () => {
      expect(
        statusForSelectedCloudPullRequest(
          // The branch's own persisted lifecycle value. OPEN is the ordinary
          // case and is held constant across every row so the only thing
          // varying between the two surfaces' runs is the PR evidence itself.
          GitHubPRState.Open,
          selectedCloudCandidate(parityCase)
        )
      ).toBe(parityCase.expected);
    });
  }
});

function selectedCloudCandidate(parityCase: BranchStatusParityCase) {
  if (parityCase.evidence === BranchStatusEvidence.None) {
    return null;
  }
  return {
    ...(parityCase.evidence === BranchStatusEvidence.Unobserved
      ? { lifecycleObserved: false }
      : {}),
    source: {
      prState: parityCase.prState ?? GitHubPRState.Open,
      isDraft: parityCase.isDraft,
      mergedAt: null,
    },
  };
}
