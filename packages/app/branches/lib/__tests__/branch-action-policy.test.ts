import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  type BranchRowActionApplicability,
  type BranchRowActionPolicyInput,
  BranchRowPolicyAction,
  resolveBranchRowActionApplicability,
} from "../branch-action-policy";

const AVAILABLE: BranchRowActionApplicability = {
  [BranchRowPolicyAction.OpenDetail]: true,
  [BranchRowPolicyAction.CopyBranchName]: true,
  [BranchRowPolicyAction.OpenPullRequest]: true,
  [BranchRowPolicyAction.ViewSessions]: true,
  [BranchRowPolicyAction.BulkTagApply]: true,
};
const DENIED: BranchRowActionApplicability = Object.fromEntries(
  Object.values(BranchRowPolicyAction).map((action) => [action, false])
) as BranchRowActionApplicability;

describe("resolveBranchRowActionApplicability", () => {
  it("derives shipped row actions and bulk tag apply from production facts", () => {
    expect(resolveBranchRowActionApplicability(readyInput())).toEqual(
      AVAILABLE
    );
  });

  it("denies API mutations when the host is read-only without disabling navigation", () => {
    const applicability = resolveBranchRowActionApplicability(
      readyInput({ hostCanMutate: false })
    );

    expect(applicability[BranchRowPolicyAction.OpenDetail]).toBe(true);
    expect(applicability[BranchRowPolicyAction.CopyBranchName]).toBe(true);
    expect(applicability[BranchRowPolicyAction.OpenPullRequest]).toBe(true);
    expect(applicability[BranchRowPolicyAction.BulkTagApply]).toBe(false);
  });

  it("uses authoritative per-row tag permissions for bulk applicability", () => {
    const applicability = resolveBranchRowActionApplicability(
      readyInput({ tagPermissions: { canApply: false, canRemove: true } })
    );

    expect(applicability[BranchRowPolicyAction.BulkTagApply]).toBe(false);
  });

  it("denies artifact mutations when the row has no artifact identity", () => {
    const applicability = resolveBranchRowActionApplicability(
      readyInput({ hasArtifactIdentity: false })
    );

    expect(applicability[BranchRowPolicyAction.BulkTagApply]).toBe(false);
  });

  it("requires a current PR number and canonical URL for Open PR", () => {
    const applicability = resolveBranchRowActionApplicability(
      readyInput({ prUrl: null })
    );

    expect(applicability[BranchRowPolicyAction.OpenPullRequest]).toBe(false);
  });

  it("preserves legacy rows with explicit permissions but omitted availability", () => {
    const applicability = resolveBranchRowActionApplicability(
      readyInput({ tagAvailability: undefined })
    );

    expect(applicability[BranchRowPolicyAction.BulkTagApply]).toBe(true);
  });

  it.each([null, {}, { hostCanMutate: "future" }])(
    "fails malformed or version-skewed input closed",
    (input) => {
      expect(resolveBranchRowActionApplicability(input)).toEqual(DENIED);
    }
  );
});

function readyInput(
  overrides: Partial<BranchRowActionPolicyInput> = {}
): BranchRowActionPolicyInput {
  return {
    hasArtifactIdentity: true,
    hasDetailRoute: true,
    hasSessionsRoute: true,
    hostCanMutate: true,
    prNumber: 42,
    prUrl: "https://github.com/acme/web/pull/42",
    sessionCount: 3,
    supportsTags: true,
    tagAvailability: BranchTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
    ...overrides,
  };
}
