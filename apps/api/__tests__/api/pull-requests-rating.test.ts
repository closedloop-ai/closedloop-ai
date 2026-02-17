import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { vi } from "vitest";
import { GET, PUT } from "@/app/pull-requests/[id]/rating/route";
import {
  PullRequestNotFoundError,
  pullRequestRatingsService,
} from "@/app/pull-requests/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/pull-requests/service");

describe("GET /api/pull-requests/[id]/rating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns rating summary for pull request", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 4.5,
      count: 2,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "Great implementation!",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    };

    vi.mocked(pullRequestRatingsService.getRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
    });
    const response = await GET(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // Dates are serialized to strings by NextResponse.json()
    expect(json.data).toEqual({
      ...mockSummary,
      userRating: mockSummary.userRating
        ? {
            ...mockSummary.userRating,
            createdAt: mockSummary.userRating.createdAt.toISOString(),
            updatedAt: mockSummary.userRating.updatedAt.toISOString(),
          }
        : null,
    });
    expect(pullRequestRatingsService.getRating).toHaveBeenCalledWith(
      "pr-1",
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId
    );
  });

  it("returns summary with no user rating", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 3.0,
      count: 1,
      userRating: null,
    };

    vi.mocked(pullRequestRatingsService.getRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-2/rating",
    });
    const response = await GET(request, createMockRouteContext({ id: "pr-2" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.userRating).toBeNull();
    expect(json.data.average).toBe(3.0);
    expect(json.data.count).toBe(1);
  });

  it("returns summary with zero ratings", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 0,
      count: 0,
      userRating: null,
    };

    vi.mocked(pullRequestRatingsService.getRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-3/rating",
    });
    const response = await GET(request, createMockRouteContext({ id: "pr-3" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.count).toBe(0);
    expect(json.data.average).toBe(0);
  });

  it("returns 404 when pull request not found", async () => {
    vi.mocked(pullRequestRatingsService.getRating).mockRejectedValue(
      new PullRequestNotFoundError("pr-not-found")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-not-found/rating",
    });
    const response = await GET(
      request,
      createMockRouteContext({ id: "pr-not-found" })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 404 for cross-org pull request access", async () => {
    vi.mocked(pullRequestRatingsService.getRating).mockRejectedValue(
      new PullRequestNotFoundError("cross-org-pr")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/cross-org-pr/rating",
    });
    const response = await GET(
      request,
      createMockRouteContext({ id: "cross-org-pr" })
    );

    expect(response.status).toBe(404);
    expect(pullRequestRatingsService.getRating).toHaveBeenCalledWith(
      "cross-org-pr",
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId
    );
  });

  it("returns 500 for unexpected errors", async () => {
    vi.mocked(pullRequestRatingsService.getRating).mockRejectedValue(
      new Error("Unexpected database error")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
    });
    const response = await GET(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to fetch rating");
  });
});

describe("PUT /api/pull-requests/[id]/rating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("creates new rating successfully", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 4.0,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    vi.mocked(pullRequestRatingsService.upsertRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 4 },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // Dates are serialized to strings by NextResponse.json()
    expect(json.data).toEqual({
      ...mockSummary,
      userRating: mockSummary.userRating
        ? {
            ...mockSummary.userRating,
            createdAt: mockSummary.userRating.createdAt.toISOString(),
            updatedAt: mockSummary.userRating.updatedAt.toISOString(),
          }
        : null,
    });
    expect(pullRequestRatingsService.upsertRating).toHaveBeenCalledWith(
      "pr-1",
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId,
      4,
      undefined
    );
  });

  it("creates rating with comment", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 5.0,
      count: 1,
      userRating: {
        id: "rating-2",
        userId: "user-1",
        score: 5,
        comment: "Excellent code quality!",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    vi.mocked(pullRequestRatingsService.upsertRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 5, comment: "Excellent code quality!" },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.userRating?.comment).toBe("Excellent code quality!");
    expect(pullRequestRatingsService.upsertRating).toHaveBeenCalledWith(
      "pr-1",
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId,
      5,
      "Excellent code quality!"
    );
  });

  it("transforms empty comment string to undefined", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 3.0,
      count: 1,
      userRating: {
        id: "rating-3",
        userId: "user-1",
        score: 3,
        comment: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    vi.mocked(pullRequestRatingsService.upsertRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 3, comment: "   " }, // Whitespace-only comment
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(200);
    expect(pullRequestRatingsService.upsertRating).toHaveBeenCalledWith(
      "pr-1",
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId,
      3,
      undefined
    );
  });

  it("updates existing rating (upsert behavior)", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 4.5,
      count: 2,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "Updated comment",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      },
    };

    vi.mocked(pullRequestRatingsService.upsertRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 5, comment: "Updated comment" },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.userRating?.score).toBe(5);
    expect(json.data.userRating?.comment).toBe("Updated comment");
  });

  it("returns 400 for invalid score (below 1)", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 0 },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(pullRequestRatingsService.upsertRating).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid score (above 5)", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 6 },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(pullRequestRatingsService.upsertRating).not.toHaveBeenCalled();
  });

  it("returns 400 for non-integer score", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 3.5 },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 for non-number score", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: "five" },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 for comment exceeding 500 characters", async () => {
    const longComment = "a".repeat(501);
    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 4, comment: longComment },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(pullRequestRatingsService.upsertRating).not.toHaveBeenCalled();
  });

  it("returns 400 for missing score", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { comment: "Comment without score" },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 404 when pull request not found", async () => {
    vi.mocked(pullRequestRatingsService.upsertRating).mockRejectedValue(
      new PullRequestNotFoundError("pr-not-found")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-not-found/rating",
      method: "PUT",
      body: { score: 4 },
    });
    const response = await PUT(
      request,
      createMockRouteContext({ id: "pr-not-found" })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 404 for cross-org pull request access", async () => {
    vi.mocked(pullRequestRatingsService.upsertRating).mockRejectedValue(
      new PullRequestNotFoundError("cross-org-pr")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/cross-org-pr/rating",
      method: "PUT",
      body: { score: 4 },
    });
    const response = await PUT(
      request,
      createMockRouteContext({ id: "cross-org-pr" })
    );

    expect(response.status).toBe(404);
    expect(pullRequestRatingsService.upsertRating).toHaveBeenCalledWith(
      "cross-org-pr",
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId,
      4,
      undefined
    );
  });

  it("returns 500 for unexpected errors", async () => {
    vi.mocked(pullRequestRatingsService.upsertRating).mockRejectedValue(
      new Error("Unexpected database error")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 4 },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Failed to submit rating");
  });

  it("returns updated aggregate after upsert", async () => {
    const mockSummary: PullRequestRatingSummary = {
      average: 4.0,
      count: 3,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    vi.mocked(pullRequestRatingsService.upsertRating).mockResolvedValue(
      mockSummary
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/pull-requests/pr-1/rating",
      method: "PUT",
      body: { score: 5 },
    });
    const response = await PUT(request, createMockRouteContext({ id: "pr-1" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.average).toBe(4.0);
    expect(json.data.count).toBe(3);
  });
});
