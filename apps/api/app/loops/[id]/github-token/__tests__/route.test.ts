import { verifyLoopRunnerToken } from "@repo/auth/loop-runner-jwt";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { extractBearerToken } from "@/lib/auth/loop-runner-jwt";
import { resolveGitHubToken } from "@/lib/loops/loop-orchestrator";
import { loopsService } from "../../../service";
import { POST } from "../route";

// Mock dependencies
vi.mock("../../../service", () => ({
  loopsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  extractBearerToken: vi.fn(),
}));

vi.mock("@repo/auth/loop-runner-jwt", () => ({
  verifyLoopRunnerToken: vi.fn(),
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  resolveGitHubToken: vi.fn(),
}));

describe("POST /api/loops/:id/github-token", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("returns fresh token and additionalRepoTokens when additionalRepos exist", async () => {
    const loopId = "loop-123";
    const orgId = "org-456";
    const token = "mock-jwt-token";

    vi.mocked(extractBearerToken).mockReturnValue(token);
    vi.mocked(verifyLoopRunnerToken).mockResolvedValue({
      loopId,
      organizationId: orgId,
    } as any);

    vi.mocked(loopsService.findById).mockResolvedValue({
      id: loopId,
      repo: { fullName: "owner/primary" },
      additionalRepos: [
        { fullName: "owner/peer1", branch: "main" },
        { fullName: "owner/peer2", branch: "main" },
      ],
    } as any);

    vi.mocked(resolveGitHubToken).mockImplementation(
      async (_orgId, repoFullName) => `token-for-${repoFullName}`
    );

    const req = new NextRequest(
      `http://localhost/api/loops/${loopId}/github-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const res = await POST(req, { params: Promise.resolve({ id: loopId }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      token: "token-for-owner/primary",
      additionalRepoTokens: [
        { fullName: "owner/peer1", token: "token-for-owner/peer1" },
        { fullName: "owner/peer2", token: "token-for-owner/peer2" },
      ],
    });

    expect(resolveGitHubToken).toHaveBeenCalledTimes(3);
    expect(resolveGitHubToken).toHaveBeenCalledWith(orgId, "owner/primary");
    expect(resolveGitHubToken).toHaveBeenCalledWith(orgId, "owner/peer1");
    expect(resolveGitHubToken).toHaveBeenCalledWith(orgId, "owner/peer2");
  });

  test("returns only fresh token when additionalRepos is empty", async () => {
    const loopId = "loop-123";
    const orgId = "org-456";
    const token = "mock-jwt-token";

    vi.mocked(extractBearerToken).mockReturnValue(token);
    vi.mocked(verifyLoopRunnerToken).mockResolvedValue({
      loopId,
      organizationId: orgId,
    } as any);

    vi.mocked(loopsService.findById).mockResolvedValue({
      id: loopId,
      repo: { fullName: "owner/primary" },
      additionalRepos: null,
    } as any);

    vi.mocked(resolveGitHubToken).mockResolvedValue("token-for-owner/primary");

    const req = new NextRequest(
      `http://localhost/api/loops/${loopId}/github-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const res = await POST(req, { params: Promise.resolve({ id: loopId }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      token: "token-for-owner/primary",
      additionalRepoTokens: [],
    });

    expect(resolveGitHubToken).toHaveBeenCalledTimes(1);
  });
});
