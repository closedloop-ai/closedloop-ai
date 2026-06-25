import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
}));

vi.mock("./branch-artifact-service", async () => {
  const actual = await vi.importActual<
    typeof import("./branch-artifact-service")
  >("./branch-artifact-service");
  return {
    ...actual,
    createLoopBranchArtifact: vi.fn(),
  };
});

import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { Result, Status } from "@repo/api/src/types/result";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import { createLoopBranchArtifact } from "./branch-artifact-service";
import { POST } from "./route";

const LOOP_ID = "019e293c-b1be-7640-bfce-464d5732c114";
const ORG_ID = "019e0805-c8c1-74b6-ba51-2a84a6dc840a";

function request(body: unknown): Request {
  return new Request(`http://localhost/api/loops/${LOOP_ID}/branch-artifact`, {
    method: "POST",
    headers: {
      authorization: "Bearer runner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/loops/:id/branch-artifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      tokenId: "token-id",
    });
  });

  it("passes authenticated loop context and branch payload to the service", async () => {
    vi.mocked(createLoopBranchArtifact).mockResolvedValue(
      Result.ok({ id: "branch-artifact-1" })
    );

    const response = await POST(
      request({
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "symphony/fea-1116",
        defaultBranch: "main",
        baseBranch: "main",
        headSha: "abc123def456abc123def456abc123def456abcd",
      }),
      { params: Promise.resolve({ id: LOOP_ID }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: "branch-artifact-1" },
    });
    expect(createLoopBranchArtifact).toHaveBeenCalledWith({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "symphony/fea-1116",
        defaultBranch: "main",
        baseBranch: "main",
        headSha: "abc123def456abc123def456abc123def456abcd",
      },
    });
  });

  it("rejects body-supplied sourceArtifactId at the JSON boundary", async () => {
    const response = await POST(
      request({
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "symphony/fea-1116",
        defaultBranch: "main",
        baseBranch: "main",
        headSha: "abc123def456abc123def456abc123def456abcd",
        sourceArtifactId: "019e2795-36d3-777e-a111-0085cb238286",
      }),
      { params: Promise.resolve({ id: LOOP_ID }) }
    );

    expect(response.status).toBe(400);
    expect(createLoopBranchArtifact).not.toHaveBeenCalled();
  });

  it("rejects branch names over the shared branch-name limit at the JSON boundary", async () => {
    const response = await POST(
      request({
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "a".repeat(BRANCH_NAME_MAX_LENGTH + 1),
        defaultBranch: "main",
        baseBranch: "main",
        headSha: "abc123def456abc123def456abc123def456abcd",
      }),
      { params: Promise.resolve({ id: LOOP_ID }) }
    );

    expect(response.status).toBe(400);
    expect(createLoopBranchArtifact).not.toHaveBeenCalled();
  });

  it("preserves legacy callback compatibility at the JSON boundary", async () => {
    vi.mocked(createLoopBranchArtifact).mockResolvedValue(
      Result.ok({ id: "branch-artifact-1" })
    );

    const response = await POST(
      request({
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "feature/legacy",
        defaultBranch: "main",
        headSha: "not-a-sha",
      }),
      { params: Promise.resolve({ id: LOOP_ID }) }
    );

    expect(response.status).toBe(200);
    expect(createLoopBranchArtifact).toHaveBeenCalledWith({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      body: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "feature/legacy",
        defaultBranch: "main",
        headSha: "not-a-sha",
      },
    });
  });

  it("maps unauthorized repo/source decisions to 403", async () => {
    vi.mocked(createLoopBranchArtifact).mockResolvedValue(
      Result.err(Status.Forbidden)
    );

    const response = await POST(
      request({
        repositoryFullName: "evil/repo",
        branchName: "symphony/fea-1116",
        defaultBranch: "main",
        baseBranch: "main",
        headSha: "abc123def456abc123def456abc123def456abcd",
      }),
      { params: Promise.resolve({ id: LOOP_ID }) }
    );

    expect(response.status).toBe(403);
  });
});
