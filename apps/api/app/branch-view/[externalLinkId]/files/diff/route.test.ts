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
    expect(mocks.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      }),
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
});
