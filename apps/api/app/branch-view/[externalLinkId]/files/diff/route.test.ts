import { BranchViewFileDiffErrorCode } from "@repo/api/src/types/branch-view";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchViewContextCredentialMode,
  BranchViewContextCredentialSource,
} from "@/lib/resolve-pr-context";

const mocks = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  resolvePrContext: vi.fn(),
  user: { id: "user-1", organizationId: "org-1" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) =>
      handler({ user: mocks.user }, request, context.params),
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  BranchViewContextCredentialMode: {
    PinnedActiveOnly: "pinned_active_only",
    RenderRead: "render_read",
  },
  BranchViewContextCredentialSource: {
    PinnedActive: "pinned_active",
    ActiveSibling: "active_sibling",
  },
  resolvePrContext: mocks.resolvePrContext,
}));

vi.mock("./service", () => ({
  getFileDiff: mocks.getFileDiff,
}));

import { GET } from "./route";

function request(path = "src/changed.ts") {
  return new NextRequest(
    `https://api.example.test/branch-view/branch-artifact-1/files/diff?path=${encodeURIComponent(
      path
    )}`
  );
}

function routeContext() {
  return { params: Promise.resolve({ externalLinkId: "branch-artifact-1" }) };
}

describe("GET /branch-view/[externalLinkId]/files/diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrContext.mockResolvedValue({
      externalLink: { id: "branch-artifact-1" },
      credentialSource: BranchViewContextCredentialSource.ActiveSibling,
    });
    mocks.getFileDiff.mockResolvedValue({
      data: {
        path: "src/changed.ts",
        oldContent: "old",
        newContent: "new",
        isNew: false,
        isDeleted: false,
        isBinary: false,
      },
      error: null,
    });
  });

  it("opts into RenderRead so recoverable active-sibling branches can fetch diffs", async () => {
    const response = await GET(request(), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.resolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1",
      { credentialMode: BranchViewContextCredentialMode.RenderRead }
    );
    // The requesting user's id rides along so the service can resolve the
    // PLN-1525 read-as-user credential.
    expect(mocks.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      }),
      "user-1",
      "src/changed.ts",
      null
    );
  });

  it("fails before file-diff service work when no active sibling can resolve", async () => {
    mocks.resolvePrContext.mockResolvedValueOnce(null);

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: "Branch view not found",
    });
    expect(mocks.getFileDiff).not.toHaveBeenCalled();
  });

  it.each([
    GitHubAccessDenialReason.NotConnected,
    GitHubAccessDenialReason.Revoked,
    GitHubAccessDenialReason.NoInstallation,
  ])("answers 403 with the %s reason when the user's credential cannot read the repo", async (reason) => {
    mocks.getFileDiff.mockResolvedValueOnce({
      data: null,
      error: "File diff unavailable",
      accessDenial: { reason },
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    // 403, not 404: the diff exists and the branch is legitimately visible —
    // only this user's GitHub credential cannot reach the repository. The
    // reason drives which remediation the client offers.
    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Forbidden",
      code: BranchViewFileDiffErrorCode.GithubAccessDenied,
      details: { accessDenial: reason },
    });
  });

  it("keeps answering 404 for a path that is genuinely not in the branch", async () => {
    // A miss with no accessDenial must not be reported as a permission
    // problem — the two states drive different UI.
    mocks.getFileDiff.mockResolvedValueOnce({
      data: null,
      error: "File is not part of this branch",
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: "File is not part of this branch not found",
    });
  });
  it("answers 429 with Retry-After when GitHub rate-limited the read", async () => {
    // Not 403: a rate limit is transient, and this route's 403 contractually
    // means "no access to this Branch View" (the file-diff hook opts out of the
    // shell re-auth boundary on that basis). Filing a rate limit there would
    // read as a permanent authorization failure.
    mocks.getFileDiff.mockResolvedValueOnce({
      data: null,
      error: "File diff unavailable",
      accessDenial: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 42,
      },
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(body).toEqual({
      success: false,
      error: "GitHub rate limit reached",
      code: BranchViewFileDiffErrorCode.GithubAccessDenied,
      details: {
        accessDenial: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 42,
      },
    });
  });

  it("omits Retry-After when GitHub supplied no ETA", async () => {
    mocks.getFileDiff.mockResolvedValueOnce({
      data: null,
      error: "File diff unavailable",
      accessDenial: { reason: GitHubAccessDenialReason.RateLimited },
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(body.details).toEqual({
      accessDenial: GitHubAccessDenialReason.RateLimited,
    });
  });

  it("answers 503 when GitHub itself was unavailable", async () => {
    mocks.getFileDiff.mockResolvedValueOnce({
      data: null,
      error: "File diff unavailable",
      accessDenial: { reason: GitHubAccessDenialReason.Unavailable },
    });

    const response = await GET(request(), routeContext());

    expect(response.status).toBe(503);
  });
});
