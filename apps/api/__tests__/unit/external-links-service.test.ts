import { vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { externalLinksService } from "@/app/external-links/service";

describe("externalLinksService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findAll filter precedence", () => {
    it("filters by projectId when workstreamId is absent", async () => {
      const mockDb = {
        externalLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.findAll({
        organizationId: "org-1",
        projectId: "proj-1",
      });

      expect(mockDb.externalLink.findMany).toHaveBeenCalledWith({
        where: { organizationId: "org-1", projectId: "proj-1" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("ignores projectId when workstreamId is present", async () => {
      const mockDb = {
        externalLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.findAll({
        organizationId: "org-1",
        workstreamId: "ws-1",
        projectId: "proj-1",
      });

      expect(mockDb.externalLink.findMany).toHaveBeenCalledWith({
        where: { organizationId: "org-1", workstreamId: "ws-1" },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("create metadata handling", () => {
    it("uses DbNull when metadata is null", async () => {
      const mockDb = {
        externalLink: {
          create: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.create("org-1", {
        type: "FIGMA_DESIGN" as const,
        title: "Design",
        externalUrl: "https://figma.com/file/abc",
        metadata: null,
      });

      expect(mockDb.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: "DbNull",
        }),
      });
    });

    it("uses DbNull when metadata is undefined", async () => {
      const mockDb = {
        externalLink: {
          create: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.create("org-1", {
        type: "FIGMA_DESIGN" as const,
        title: "Design",
        externalUrl: "https://figma.com/file/abc",
      });

      expect(mockDb.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: "DbNull",
        }),
      });
    });
  });

  describe("update metadata handling", () => {
    it("sets metadata to DbNull when explicitly null", async () => {
      const mockDb = {
        externalLink: {
          update: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.update("org-1", "link-1", {
        metadata: null,
      });

      expect(mockDb.externalLink.update).toHaveBeenCalledWith({
        where: { id: "link-1", organizationId: "org-1" },
        data: {
          metadata: "DbNull",
        },
      });
    });

    it("preserves metadata when undefined (not provided)", async () => {
      const mockDb = {
        externalLink: {
          update: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.update("org-1", "link-1", {
        title: "New Title",
      });

      expect(mockDb.externalLink.update).toHaveBeenCalledWith({
        where: { id: "link-1", organizationId: "org-1" },
        data: {
          title: "New Title",
          metadata: undefined,
        },
      });
    });
  });

  describe("delete", () => {
    it("cleans up entity links before deleting external link in transaction", async () => {
      const mockTx = {
        entityLink: {
          deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
        externalLink: {
          delete: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbTx(mockTx);

      await externalLinksService.delete("org-1", "link-1");

      expect(mockTx.entityLink.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { sourceId: "link-1", sourceType: "EXTERNAL_LINK" },
            { targetId: "link-1", targetType: "EXTERNAL_LINK" },
          ],
        },
      });
      expect(mockTx.externalLink.delete).toHaveBeenCalledWith({
        where: { id: "link-1", organizationId: "org-1" },
      });
    });
  });
});
