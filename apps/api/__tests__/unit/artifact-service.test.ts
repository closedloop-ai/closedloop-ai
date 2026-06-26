import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import { ArtifactType } from "@repo/database";
import { artifactService } from "@/app/artifacts/artifact-service";

const ORG_ID = "org-1";

describe("artifactService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findById", () => {
    it("queries artifact.findUnique scoped to organization", async () => {
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue({ id: "art-1" }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await artifactService.findById("art-1", ORG_ID);

      expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: "art-1", organizationId: ORG_ID },
      });
      expect(result).toEqual({ id: "art-1" });
    });

    it("returns null when no artifact matches", async () => {
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await artifactService.findById("missing", ORG_ID);

      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    let mockDb: { artifact: { findMany: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
      mockDb = {
        artifact: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);
    });

    it("filters out template artifacts by default", async () => {
      await artifactService.list({ organizationId: ORG_ID });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          subtype: { not: ArtifactSubtype.Template },
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("adds projectId filter when provided", async () => {
      await artifactService.list({
        organizationId: ORG_ID,
        projectId: "proj-1",
      });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          projectId: "proj-1",
          subtype: { not: ArtifactSubtype.Template },
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("adds workstreamId, type, and assigneeId filters when provided", async () => {
      await artifactService.list({
        organizationId: ORG_ID,
        type: ArtifactType.BRANCH,
        assigneeId: "user-1",
      });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.BRANCH,
          assigneeId: "user-1",
          subtype: { not: ArtifactSubtype.Template },
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("omits optional filters when they are undefined", async () => {
      await artifactService.list({
        organizationId: ORG_ID,
        projectId: undefined,
        type: undefined,
        assigneeId: undefined,
      });

      const where = mockDb.artifact.findMany.mock.calls[0][0].where;
      expect(where).not.toHaveProperty("projectId");
      expect(where).not.toHaveProperty("workstreamId");
      expect(where).not.toHaveProperty("type");
      expect(where).not.toHaveProperty("assigneeId");
    });
  });

  describe("listTemplates", () => {
    it("queries DOCUMENT artifacts with the Template subtype", async () => {
      const mockDb = {
        artifact: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await artifactService.listTemplates(ORG_ID);

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.Template,
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("findSourceLinks", () => {
    it("queries artifactLinks where artifact is the source", async () => {
      const mockDb = {
        artifactLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await artifactService.findSourceLinks("art-1", ORG_ID);

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
        where: { sourceId: "art-1", organizationId: ORG_ID },
      });
    });
  });

  describe("findTargetLinks", () => {
    it("queries artifactLinks where artifact is the target", async () => {
      const mockDb = {
        artifactLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);

      await artifactService.findTargetLinks("art-1", ORG_ID);

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
        where: { targetId: "art-1", organizationId: ORG_ID },
      });
    });
  });
});
