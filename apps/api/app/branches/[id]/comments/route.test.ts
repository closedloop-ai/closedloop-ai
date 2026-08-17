import {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchComments: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request, context.params);
    },
}));

vi.mock("@/app/branches/branch-comments-service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/branches/branch-comments-service")
    >();
  return {
    ...actual,
    branchCommentsService: {
      getBranchComments: mocks.getBranchComments,
    },
  };
});

import { GET } from "./route";

const branchId = "11111111-1111-4111-8111-111111111111";

describe("GET /branches/[id]/comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.getBranchComments.mockResolvedValue(commentsResponse());
  });

  it("requires read scope and returns org-scoped branch comments", async () => {
    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchComments).toHaveBeenCalledWith("org-1", branchId, {});
    expect(body).toEqual({ success: true, data: commentsResponse() });
  });

  it("rejects unsupported query params instead of silently dropping filters", async () => {
    const response = await GET(
      request("unsupported=value"),
      routeContext(branchId)
    );

    expect(response.status).toBe(400);
    expect(mocks.getBranchComments).not.toHaveBeenCalled();
  });

  it("returns not found when the branch comments service has no scoped match", async () => {
    mocks.getBranchComments.mockResolvedValueOnce(null);

    const response = await GET(request(), routeContext(branchId));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: "Branch not found" });
  });
});

function request(query = "") {
  const suffix = query ? `?${query}` : "";
  return new NextRequest(
    `https://api.example.test/branches/${branchId}/comments${suffix}`,
    { method: "GET" }
  );
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function commentsResponse() {
  return {
    branchId,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    state: BranchCommentsState.StaleMixed,
    comments: [
      {
        id: "review-1",
        providerNodeId: "PRRC_1",
        providerCommentId: "1",
        kind: BranchPrCommentKind.Review,
        threadId: "thread-1",
        inReplyToId: null,
        path: "packages/app/branches/components/comments/branch-comment-card.tsx",
        line: 42,
        resolved: false,
        author: {
          login: "reviewer",
          displayName: "Review Author",
          avatarUrl: "https://avatars.example/reviewer.png",
          profileUrl: "https://github.com/reviewer",
        },
        body: "Review body",
        createdAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T10:01:00.000Z",
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r1",
        stale: true,
        bodyTruncated: true,
      },
    ],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16_384,
      maxResponseBytes: 524_288,
      providerTruncated: true,
      responseTruncated: true,
      omittedComments: 3,
      bodyTruncatedCount: 1,
    },
    providerProofedAt: "2026-08-10T10:02:00.000Z",
    stale: true,
    mixedProjection: true,
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
  };
}
