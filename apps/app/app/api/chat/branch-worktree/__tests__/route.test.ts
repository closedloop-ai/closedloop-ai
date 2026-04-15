// @vitest-environment node

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockResolveBranchWorktree = vi.fn();
vi.mock("@/lib/engineer/branch-worktree", () => ({
  resolveBranchWorktree: (...args: unknown[]) =>
    mockResolveBranchWorktree(...args),
}));

const { GET } = await import("../route");

function createMockRequest(
  search = "repoFullName=closedloop%2Fclosedloop-electron&headBranch=feat%2Fpr-42&prNumber=42"
): NextRequest {
  return new Request(
    `http://localhost:3000/api/chat/branch-worktree?${search}`
  ) as unknown as NextRequest;
}

describe("GET /api/chat/branch-worktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns the resolved branch worktree path", async () => {
    mockResolveBranchWorktree.mockReturnValue({
      path: "/tmp/worktrees/closedloop-electron-pr-42",
      repoPath: "/Users/dev/Source/closedloop-electron",
    });

    const response = await GET(createMockRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/tmp/worktrees/closedloop-electron-pr-42",
      repoPath: "/Users/dev/Source/closedloop-electron",
    });
    expect(mockResolveBranchWorktree).toHaveBeenCalledWith(
      "closedloop/closedloop-electron",
      "feat/pr-42",
      42
    );
  });

  test("returns null fields when no matching local repo is configured", async () => {
    mockResolveBranchWorktree.mockReturnValue(null);

    const response = await GET(createMockRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: null,
      repoPath: null,
    });
  });

  test("returns 400 when required params are missing", async () => {
    const response = await GET(
      createMockRequest("repoFullName=closedloop%2Frepo")
    );

    expect(response.status).toBe(400);
    expect(mockResolveBranchWorktree).not.toHaveBeenCalled();
  });
});
