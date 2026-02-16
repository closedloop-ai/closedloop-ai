import { vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { entityLinksService } from "@/app/entity-links/service";

describe("entityLinksService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createLink metadata handling", () => {
    it("uses DbNull when metadata is null", async () => {
      const mockDb = {
        entityLink: {
          create: vi.fn().mockResolvedValue({ id: "el-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.createLink({
        sourceId: "a-1",
        sourceType: "ARTIFACT" as const,
        targetId: "a-2",
        targetType: "ARTIFACT" as const,
        linkType: "RELATES_TO" as const,
        metadata: null,
      });

      expect(mockDb.entityLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: "DbNull",
        }),
      });
    });

    it("uses DbNull when metadata is undefined", async () => {
      const mockDb = {
        entityLink: {
          create: vi.fn().mockResolvedValue({ id: "el-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.createLink({
        sourceId: "a-1",
        sourceType: "ARTIFACT" as const,
        targetId: "a-2",
        targetType: "ARTIFACT" as const,
        linkType: "BLOCKS" as const,
      });

      expect(mockDb.entityLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: "DbNull",
        }),
      });
    });
  });

  describe("findLinks builds bidirectional OR query", () => {
    it("queries both source and target sides", async () => {
      const mockDb = {
        entityLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.findLinks("artifact-1", "ARTIFACT");

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { sourceId: "artifact-1", sourceType: "ARTIFACT" },
            { targetId: "artifact-1", targetType: "ARTIFACT" },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("adds linkType filter to both OR branches", async () => {
      const mockDb = {
        entityLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.findLinks("artifact-1", "ARTIFACT", "PRODUCES");

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            {
              sourceId: "artifact-1",
              sourceType: "ARTIFACT",
              linkType: "PRODUCES",
            },
            {
              targetId: "artifact-1",
              targetType: "ARTIFACT",
              linkType: "PRODUCES",
            },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("directional queries", () => {
    it("findSourceLinks queries by targetId (incoming links)", async () => {
      const mockDb = {
        entityLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.findSourceLinks("artifact-1", "ARTIFACT");

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          targetId: "artifact-1",
          targetType: "ARTIFACT",
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("findTargetLinks queries by sourceId (outgoing links)", async () => {
      const mockDb = {
        entityLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.findTargetLinks("artifact-1", "ARTIFACT");

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          sourceId: "artifact-1",
          sourceType: "ARTIFACT",
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("resolveEntity dispatches by type", () => {
    it("resolves ARTIFACT with owner/approver includes", async () => {
      const mockArtifact = { id: "a-1", title: "My PRD" };
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue(mockArtifact),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity("a-1", "ARTIFACT");

      expect(result).toEqual({ type: "ARTIFACT", entity: mockArtifact });
      expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: "a-1" },
        include: {
          owner: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
          approver: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      });
    });

    it("resolves ISSUE with assignee/createdBy includes", async () => {
      const mockIssue = { id: "i-1", title: "Bug report" };
      const mockDb = {
        issue: {
          findUnique: vi.fn().mockResolvedValue(mockIssue),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity("i-1", "ISSUE");

      expect(result).toEqual({ type: "ISSUE", entity: mockIssue });
      expect(mockDb.issue.findUnique).toHaveBeenCalledWith({
        where: { id: "i-1" },
        include: {
          assignee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      });
    });

    it("resolves EXTERNAL_LINK without includes", async () => {
      const mockLink = { id: "el-1", title: "PR #42" };
      const mockDb = {
        externalLink: {
          findUnique: vi.fn().mockResolvedValue(mockLink),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity(
        "el-1",
        "EXTERNAL_LINK"
      );

      expect(result).toEqual({ type: "EXTERNAL_LINK", entity: mockLink });
      expect(mockDb.externalLink.findUnique).toHaveBeenCalledWith({
        where: { id: "el-1" },
      });
    });

    it("returns null for missing entity", async () => {
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity(
        "nonexistent",
        "ARTIFACT"
      );

      expect(result).toBeNull();
    });

    it("returns null for unknown entity type", async () => {
      const mockDb = {};
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity(
        "x-1",
        "UNKNOWN" as any
      );

      expect(result).toBeNull();
    });
  });
});
