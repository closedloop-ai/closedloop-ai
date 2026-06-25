import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",

    DEPLOYMENT: "DEPLOYMENT",
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    capture: vi.fn(),
  },
}));

import { pullRequestRatingsService } from "@/app/pull-requests/ratings-service";

describe("pullRequestRatingsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRating", () => {
    const mockPrArtifact = { id: "pr-1" };

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
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(mockUserRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.5 },
            _count: { _all: 2 },
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
      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
          type: "BRANCH",
        },
        select: { id: true },
      });
      expect(mockDb.artifactRating.findUnique).toHaveBeenCalledWith({
        where: {
          artifactId_userId_organizationId: {
            artifactId: "pr-1",
            userId: "user-1",
            organizationId: "org-1",
          },
        },
      });

      expect(mockDb.artifactRating.aggregate).toHaveBeenCalledWith({
        where: { artifactId: "pr-1", organizationId: "org-1" },
        _avg: { score: true },
        _count: { _all: true },
      });

      expect(result).toEqual({
        ok: true,
        value: {
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
        },
      });
    });

    it("returns rating summary with null user rating", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 3.0 },
            _count: { _all: 1 },
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
        ok: true,
        value: {
          average: 3.0,
          count: 1,
          userRating: null,
        },
      });
    });

    it("returns zero average when no ratings exist", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: null },
            _count: { _all: 0 },
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
        ok: true,
        value: {
          average: 0,
          count: 0,
          userRating: null,
        },
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
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(mockUserRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: { _all: 1 },
          }),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-1",
        "user-1",
        "org-1"
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userRating?.comment).toBe("Required feedback text");
      }
    });

    it("returns Status.NotFound when PR does not exist", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-not-found",
        "user-1",
        "org-1"
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    });

    it("returns Status.NotFound when PR belongs to different organization", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbCall(mockDb);

      const result = await pullRequestRatingsService.getRating(
        "pr-1",
        "user-1",
        "org-1"
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      // Verify the query includes organizationId filter (authorization)
      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
          type: "BRANCH",
        },
        select: { id: true },
      });
    });

    it("verifies organization via artifact org-scoping", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: { _all: 1 },
          }),
        },
      };

      mockWithDbCall(mockDb);

      await pullRequestRatingsService.getRating("pr-1", "user-1", "org-1");

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
          type: "BRANCH",
        },
        select: { id: true },
      });
    });

    it("scopes aggregate query by organization ID", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 4.0 },
            _count: { _all: 1 },
          }),
        },
      };

      mockWithDbCall(mockDb);

      await pullRequestRatingsService.getRating("pr-1", "user-1", "org-1");

      expect(mockDb.artifactRating.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
          }),
        })
      );
    });
  });

  describe("upsertRating", () => {
    const mockPrArtifact = { id: "pr-1" };

    it("creates new rating and returns summary", async () => {
      const mockNewRating = {
        id: "rating-1",
        userId: "user-1",
        score: 5,
        comment: "New rating comment",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };

      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue(mockNewRating),
          aggregate: vi.fn().mockResolvedValue({
            _avg: { score: 5.0 },
            _count: { _all: 1 },
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

      expect(mockTx.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
          type: "BRANCH",
        },
        select: { id: true },
      });

      expect(mockTx.artifactRating.upsert).toHaveBeenCalledWith({
        where: {
          artifactId_userId_organizationId: {
            artifactId: "pr-1",
            userId: "user-1",
            organizationId: "org-1",
          },
        },
        update: {
          score: 5,
          comment: "New rating comment",
        },
        create: {
          artifactId: "pr-1",
          userId: "user-1",
          organizationId: "org-1",
          score: 5,
          comment: "New rating comment",
        },
      });

      expect(result).toEqual({
        ok: true,
        value: {
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
        },
      });
    });

    it("updates existing rating and returns summary", async () => {
      const mockUpdatedRating = {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: "Updated comment",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
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
            _count: { _all: 2 },
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
        ok: true,
        value: {
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
        },
      });
    });

    it("returns Status.NotFound when PR does not exist", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbTx(mockTx);

      const result = await pullRequestRatingsService.upsertRating(
        "pr-not-found",
        "user-1",
        "org-1",
        5,
        "Comment"
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    });

    it("returns Status.NotFound when PR belongs to different organization", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      mockWithDbTx(mockTx);

      const result = await pullRequestRatingsService.upsertRating(
        "pr-1",
        "user-1",
        "org-1",
        5,
        "Comment"
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    });

    it("verifies organization via artifact org-scoping", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
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
            _count: { _all: 1 },
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

      expect(mockTx.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "pr-1",
          organizationId: "org-1",
          type: "BRANCH",
        },
        select: { id: true },
      });
    });

    it("scopes aggregate calculation by organization", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
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
            _count: { _all: 1 },
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

      expect(mockTx.artifactRating.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
          }),
        })
      );
    });

    it("persists comment in rating", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(mockPrArtifact),
        },
        artifactRating: {
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
            _count: { _all: 1 },
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

      expect(mockTx.artifactRating.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            comment: "My feedback",
          }),
          update: expect.objectContaining({
            comment: "My feedback",
          }),
        })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userRating?.comment).toBe("My feedback");
      }
    });
  });
});
