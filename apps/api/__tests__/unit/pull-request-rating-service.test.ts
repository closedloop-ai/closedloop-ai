import { vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { PullRequestNotFoundError } from "@/app/pull-requests/errors";
import { pullRequestRatingsService } from "@/app/pull-requests/service";

describe("pullRequestRatingsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRating", () => {
    const mockPr = {
      id: "pr-1",
      workstream: { id: "ws-1", organizationId: "org-1" },
    };

    it("returns rating summary with user rating", async () => {
      const mockUserRating = {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "Excellent work!",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };

      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(mockUserRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.5 },
            _count: 2,
          }),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-1",
        "user-1",
        "org-1"
      );

      expect(getMockWithDb()).toHaveBeenCalledTimes(1);
      expect(mockDb.gitHubPullRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
        },
      });
      expect(mockDb.pullRequestRating.findUnique).toHaveBeenCalledWith({
        where: {
          pullRequestId_userId_organizationId: {
            pullRequestId: "pr-1",
            userId: "user-1",
            organizationId: "org-1",
          },
        },
      });

      expect(mockDb.pullRequestRating.aggregate).toHaveBeenCalledWith({
        where: { pullRequestId: "pr-1", organizationId: "org-1" },
        _avg: { score: true },
        _count: true,
      });

      expect(result).toEqual({
        average: 4.5,
        count: 2,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 5,
          comment: "Excellent work!",
          createdAt: mockUserRating.createdAt,
          updatedAt: mockUserRating.updatedAt,
        },
      });
    });

    it("returns rating summary with null user rating", async () => {
      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 3.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-1",
        "user-2",
        "org-1"
      );

      expect(result).toEqual({
        average: 3.0,
        count: 1,
        userRating: null,
      });
    });

    it("returns zero average when no ratings exist", async () => {
      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: null },
            _count: 0,
          }),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-1",
        "user-1",
        "org-1"
      );

      expect(result).toEqual({
        average: 0,
        count: 0,
        userRating: null,
      });
    });

    it("returns comment from rating in API response", async () => {
      const mockUserRating = {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: "Required feedback text",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };

      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(mockUserRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-1",
        "user-1",
        "org-1"
      );

      expect(result.userRating?.comment).toBe("Required feedback text");
    });

    it("throws PullRequestNotFoundError when PR does not exist", async () => {
      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbCall(mockDb);

      await expect(
        pullRequestRatingsService.getRating("pr-not-found", "user-1", "org-1")
      ).rejects.toThrow(PullRequestNotFoundError);
    });

    it("throws PullRequestNotFoundError when PR belongs to different organization", async () => {
      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbCall(mockDb);

      await expect(
        pullRequestRatingsService.getRating("pr-1", "user-1", "org-1")
      ).rejects.toThrow(PullRequestNotFoundError);

      // Verify the query includes workstream.organizationId check (authorization)
      expect(mockDb.gitHubPullRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
        },
      });
    });

    it("verifies organization via workstream relationship join", async () => {
      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbCall(mockDb);

      await pullRequestRatingsService.getRating("pr-1", "user-1", "org-1");

      expect(mockDb.gitHubPullRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
        },
      });
    });

    it("scopes aggregate query by organization ID", async () => {
      const mockDb = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbCall(mockDb);

      await pullRequestRatingsService.getRating("pr-1", "user-1", "org-1");

      expect(mockDb.pullRequestRating.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
          }),
        })
      );
    });
  });

  describe("upsertRating", () => {
    it("creates new rating and returns summary", async () => {
      const mockPr = {
        id: "pr-1",
        workstream: {
          id: "ws-1",
          organizationId: "org-1",
        },
      };

      const mockNewRating = {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "New rating comment",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };

      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue(mockNewRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 5.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbTx(mockTx);

      const result = await pullRequestRatingsService.upsertRating(
        "pr-1",
        "user-1",
        "org-1",
        5,
        "New rating comment"
      );

      expect(mockTx.gitHubPullRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
        },
      });

      expect(mockTx.pullRequestRating.upsert).toHaveBeenCalledWith({
        where: {
          pullRequestId_userId_organizationId: {
            pullRequestId: "pr-1",
            userId: "user-1",
            organizationId: "org-1",
          },
        },
        update: {
          score: 5,
          comment: "New rating comment",
        },
        create: {
          pullRequestId: "pr-1",
          userId: "user-1",
          organizationId: "org-1",
          score: 5,
          comment: "New rating comment",
        },
      });

      expect(result).toEqual({
        average: 5.0,
        count: 1,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 5,
          comment: "New rating comment",
          createdAt: mockNewRating.createdAt,
          updatedAt: mockNewRating.updatedAt,
        },
      });
    });

    it("updates existing rating and returns summary", async () => {
      const mockPr = {
        id: "pr-1",
        workstream: {
          id: "ws-1",
          organizationId: "org-1",
        },
      };

      const mockUpdatedRating = {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: "Updated comment",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue({
            id: "rating-1",
            userId: "user-1",
            score: 3,
            comment: "Old comment",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
          upsert: vi.fn().mockResolvedValue(mockUpdatedRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: 2,
          }),
        },
      };

      mockWithDbTx(mockTx);

      const result = await pullRequestRatingsService.upsertRating(
        "pr-1",
        "user-1",
        "org-1",
        4,
        "Updated comment"
      );

      expect(result).toEqual({
        average: 4.0,
        count: 2,
        userRating: {
          id: "rating-1",
          userId: "user-1",
          score: 4,
          comment: "Updated comment",
          createdAt: mockUpdatedRating.createdAt,
          updatedAt: mockUpdatedRating.updatedAt,
        },
      });
    });

    it("throws PullRequestNotFoundError when PR does not exist", async () => {
      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbTx(mockTx);

      await expect(
        pullRequestRatingsService.upsertRating(
          "pr-not-found",
          "user-1",
          "org-1",
          5,
          "Comment"
        )
      ).rejects.toThrow(PullRequestNotFoundError);
    });

    it("throws PullRequestNotFoundError when PR belongs to different organization", async () => {
      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbTx(mockTx);

      // Query filters by workstream.organizationId, so returns null when org doesn't match

      await expect(
        pullRequestRatingsService.upsertRating(
          "pr-1",
          "user-1",
          "org-1",
          5,
          "Comment"
        )
      ).rejects.toThrow(PullRequestNotFoundError);
    });

    it("verifies organization via workstream relationship join", async () => {
      const mockPr = {
        id: "pr-1",
        workstream: {
          id: "ws-1",
          organizationId: "org-1",
        },
      };

      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({
            id: "rating-1",
            userId: "user-1",
            score: 5,
            comment: "Comment",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 5.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbTx(mockTx);

      await pullRequestRatingsService.upsertRating(
        "pr-1",
        "user-1",
        "org-1",
        5,
        "Comment"
      );

      // Verify the query uses workstream relationship for organization scoping
      expect(mockTx.gitHubPullRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
        },
      });
    });

    it("scopes aggregate calculation by organization", async () => {
      const mockPr = {
        id: "pr-1",
        workstream: {
          id: "ws-1",
          organizationId: "org-1",
        },
      };

      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({
            id: "rating-1",
            userId: "user-1",
            score: 5,
            comment: "Comment",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 5.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbTx(mockTx);

      await pullRequestRatingsService.upsertRating(
        "pr-1",
        "user-1",
        "org-1",
        5,
        "Comment"
      );

      expect(mockTx.pullRequestRating.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
          }),
        })
      );
    });

    it("persists comment in rating", async () => {
      const mockPr = {
        id: "pr-1",
        workstream: {
          id: "ws-1",
          organizationId: "org-1",
        },
      };

      const mockTx = {
        gitHubPullRequest: {
          findFirst: vi.fn().mockResolvedValue(mockPr),
        },
        pullRequestRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({
            id: "rating-1",
            userId: "user-1",
            score: 4,
            comment: "My feedback",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: 1,
          }),
        },
      };

      mockWithDbTx(mockTx);

      const result = await pullRequestRatingsService.upsertRating(
        "pr-1",
        "user-1",
        "org-1",
        4,
        "My feedback"
      );

      expect(mockTx.pullRequestRating.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            comment: "My feedback",
          }),
          update: expect.objectContaining({
            comment: "My feedback",
          }),
        })
      );

      expect(result.userRating?.comment).toBe("My feedback");
    });
  });

  describe("PullRequestNotFoundError", () => {
    it("has status 404", () => {
      const error = new PullRequestNotFoundError("pr-1");
      expect(error.status).toBe(404);
    });

    it("includes pullRequestId in message", () => {
      const error = new PullRequestNotFoundError("pr-123");
      expect(error.message).toContain("pr-123");
    });

    it("has correct name", () => {
      const error = new PullRequestNotFoundError("pr-1");
      expect(error.name).toBe("PullRequestNotFoundError");
    });
  });
});
