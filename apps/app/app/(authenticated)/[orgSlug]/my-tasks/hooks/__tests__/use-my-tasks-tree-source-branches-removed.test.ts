import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  branchHooks: new Map<string, ReturnType<typeof vi.fn>>(),
  useAssignedArtifactTree: vi.fn(),
}));

// Every export of the branch hooks module becomes a recorded spy, so a branch
// read reintroduced through ANY of them fails the absence assertion below.
vi.mock("@repo/app/branches/hooks/use-branches", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => {
      if (typeof value === "function") {
        const spy = vi.fn();
        mocks.branchHooks.set(name, spy);
        return [name, spy];
      }
      return [name, value];
    })
  );
});
vi.mock("@repo/app/projects/hooks/use-assigned-artifact-tree", () => ({
  useAssignedArtifactTree: mocks.useAssignedArtifactTree,
}));

import { ArtifactType } from "@repo/api/src/types/artifact";
import { useMyTasksTreeSource } from "../use-my-tasks-tree-source";

const ASSIGNEE_ID = "user-1";
const BRANCH_ID = "branch-1";
const ISSUE_ID = "issue-1";
const SESSION_ID = "session-1";

/**
 * ISS-12463 (operator ruling 2026-10-16): branches are not tasks. The tree
 * source reads no contributor branches, and prunes every branch the remaining
 * read still carries, with its subtree.
 *
 * ISS-12637 retired `my-tasks-own-work-tree`, which took four cases from this
 * file with it. Two asserted pruning and contributor-read absence on the legacy
 * per-project fan-out arm; the `missing My Tasks project reconciliation` block
 * asserted the retry behaviour that existed only because that arm's 404s had to
 * be retired by fresh source ids. Both contracts are gone, so no flag is seeded
 * here — the hook has one read and this suite asserts it at default config.
 */
describe("useMyTasksTreeSource without branches (ISS-12463)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The one read can still carry a branch, because its downward walk is
    // deliberately kept — that is what there is left to prune.
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: treeWithBranchUnderIssue(),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  it("prunes the branch the kept downward walk still returns, with its sessions", () => {
    const { result } = renderHook(() => useMyTasksTreeSource(params()));

    expect(result.current.treeData?.nodes.map((n) => n.root.id)).toEqual([
      ISSUE_ID,
    ]);
    expect(
      result.current.treeData?.nodes.flatMap((n) => n.children.map((c) => c.id))
    ).toEqual([]);
  });

  it("never reads contributor branches through any branch hook", () => {
    renderHook(() => useMyTasksTreeSource(params()));

    for (const [name, spy] of mocks.branchHooks) {
      expect(spy, `${name} was called`).not.toHaveBeenCalled();
    }
  });
});

function params() {
  return { assigneeId: ASSIGNEE_ID, isListView: true };
}

function treeWithBranchUnderIssue() {
  return {
    externalParents: [],
    nodes: [
      {
        root: { id: ISSUE_ID, type: ArtifactType.Document },
        children: [
          {
            id: BRANCH_ID,
            type: ArtifactType.Branch,
            parentId: ISSUE_ID,
            depth: 1,
          },
          {
            id: SESSION_ID,
            type: ArtifactType.Session,
            parentId: BRANCH_ID,
            depth: 2,
          },
        ],
      },
    ],
  };
}
