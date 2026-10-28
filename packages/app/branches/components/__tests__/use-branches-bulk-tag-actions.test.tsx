import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { useBranchesBulkTagActions } from "../use-branches-bulk-tag-actions";

type BulkTagTarget = {
  artifactId?: string;
  canApply: boolean;
  rowId: string;
};

const mocks = vi.hoisted(() => ({
  useBulkTagFamilyActions: vi.fn(
    (_input: {
      addTargets: BulkTagTarget[];
      queryClient: unknown;
      removeTargets: BulkTagTarget[];
    }) => []
  ),
}));

vi.mock("../../../tags/components/bulk-tag-action", () => ({
  useBulkTagFamilyActions: mocks.useBulkTagFamilyActions,
}));

const row: BranchRow = {
  id: "owner%2Frepo::feature",
  artifactId: "artifact-1",
  branchName: "feature",
  baseBranch: "main",
  repo: "owner/repo",
  owner: "Owner",
  status: BranchRowStatus.Open,
  dataState: BranchDataState.Ready,
  prNumber: null,
  prTitle: null,
  prUrl: null,
  prState: null,
  checksPassed: null,
  checksTotal: null,
  checksStatus: null,
  behind: null,
  ahead: null,
  additions: null,
  deletions: null,
  sessionCount: 0,
  commentCount: null,
  lastActivityLabel: "now",
  tagAvailability: BranchTagAvailability.Available,
  tagPermissions: { canApply: true, canRemove: false },
};

describe("useBranchesBulkTagActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a writable target only when host and row permission allow it", () => {
    const { rerender } = renderHook(
      ({ readOnly }) => useBranchesBulkTagActions([row], readOnly),
      {
        initialProps: { readOnly: false },
        wrapper: AppCoreStoryProviders,
      }
    );

    expect(lastTargets()).toEqual([
      { artifactId: "artifact-1", canApply: true, rowId: row.id },
    ]);

    rerender({ readOnly: true });
    expect(lastTargets()).toEqual([
      { artifactId: "artifact-1", canApply: false, rowId: row.id },
    ]);
  });

  it("denies a writable host when the producer reports tag hydration unavailable", () => {
    renderHook(
      () =>
        useBranchesBulkTagActions([
          { ...row, tagAvailability: BranchTagAvailability.Unavailable },
        ]),
      { wrapper: AppCoreStoryProviders }
    );

    expect(lastTargets()[0]?.canApply).toBe(false);
  });
});

function lastTargets(): BulkTagTarget[] {
  const input = mocks.useBulkTagFamilyActions.mock.calls.at(-1)?.[0];
  if (!input) {
    throw new Error("useBulkTagFamilyActions was not called");
  }
  return input.addTargets;
}
