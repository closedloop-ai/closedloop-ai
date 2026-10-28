import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import { describe, expect, it } from "vitest";
import { adaptAgentComponentBranches } from "../agent-component-branch-adapter";

function makeWireBranchRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    id: "branch-1",
    branchName: "feature/foo",
    baseBranch: "main",
    repoFullName: "closedloop-ai/closedloop-ai",
    owner: "tamsin",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    sessionIds: ["session-1", "session-2"],
    estimatedCostUsd: null,
    ...overrides,
  };
}

describe("adaptAgentComponentBranches", () => {
  it("delegates to the canonical adaptBranchRows helper, producing an identical result", () => {
    const branches = [
      makeWireBranchRow(),
      makeWireBranchRow({ id: "branch-2", status: BranchStatus.Merged }),
    ];

    expect(adaptAgentComponentBranches(branches)).toEqual(
      adaptBranchRows(branches)
    );
  });

  it("maps the session count from the wire row's sessionIds length", () => {
    const [row] = adaptAgentComponentBranches([makeWireBranchRow()]);

    expect(row.sessionCount).toBe(2);
  });

  it("maps a wire status to its render status", () => {
    const [row] = adaptAgentComponentBranches([
      makeWireBranchRow({ status: BranchStatus.Merged }),
    ]);

    expect(row.status).toBe("merged");
  });

  it("returns an empty array for an empty input", () => {
    expect(adaptAgentComponentBranches([])).toEqual([]);
  });

  it("preserves row order and count across multiple branches", () => {
    const branches = [
      makeWireBranchRow({ id: "branch-a" }),
      makeWireBranchRow({ id: "branch-b" }),
      makeWireBranchRow({ id: "branch-c" }),
    ];

    const result = adaptAgentComponentBranches(branches);

    expect(result.map((row) => row.id)).toEqual([
      "branch-a",
      "branch-b",
      "branch-c",
    ]);
  });
});
