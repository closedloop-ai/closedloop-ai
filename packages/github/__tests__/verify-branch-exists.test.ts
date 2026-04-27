import type { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { verifyBranchExists } from "../index";

const OWNER = "acme";
const REPO = "my-repo";
const BRANCH = "feature/my-branch";

function makeOctokit(getBranch: ReturnType<typeof vi.fn>): Octokit {
  return {
    rest: {
      repos: {
        getBranch,
      },
    },
  } as unknown as Octokit;
}

describe("verifyBranchExists", () => {
  let mockGetBranch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetBranch = vi.fn();
  });

  it("returns true when the branch exists", async () => {
    mockGetBranch.mockResolvedValueOnce({ data: { name: BRANCH } });

    const result = await verifyBranchExists(
      makeOctokit(mockGetBranch),
      OWNER,
      REPO,
      BRANCH
    );

    expect(result).toBe(true);
    expect(mockGetBranch).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
    });
  });

  it("returns false when the branch does not exist (404)", async () => {
    mockGetBranch.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const result = await verifyBranchExists(
      makeOctokit(mockGetBranch),
      OWNER,
      REPO,
      BRANCH
    );

    expect(result).toBe(false);
    expect(mockGetBranch).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
    });
  });

  it("throws a descriptive error on non-404 failures", async () => {
    mockGetBranch.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );

    await expect(
      verifyBranchExists(makeOctokit(mockGetBranch), OWNER, REPO, BRANCH)
    ).rejects.toThrow(
      `Failed to verify branch "${BRANCH}" in ${OWNER}/${REPO}: Forbidden`
    );
  });
});
