import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import { TAG_COLORS, TagEntityType } from "@repo/api/src/types/tag";
import { DuplicateNameError, tagService } from "@/app/tags/service";

const ORG_ID = "org-123";
const USER_ID = "user-456";
const TAG_ID = "tag-789";

function makeTag(overrides?: Record<string, unknown>) {
  return {
    id: TAG_ID,
    organizationId: ORG_ID,
    name: "Bug",
    color: "red",
    createdById: USER_ID,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    createdBy: {
      id: USER_ID,
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
    },
    _count: {
      tagProjects: 0,
      tagArtifacts: 0,
      tagLoops: 0,
    },
    ...overrides,
  };
}

describe("tagService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findByOrg", () => {
    it("returns all tags for the org ordered by name with counts", async () => {
      const tags = [
        makeTag({ name: "Alpha" }),
        makeTag({ id: "tag-2", name: "Beta" }),
      ];
      const mockDb = {
        tag: { findMany: vi.fn().mockResolvedValue(tags) },
      };
      mockWithDbCall(mockDb);

      const result = await tagService.findByOrg(ORG_ID);

      expect(mockDb.tag.findMany).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
        include: expect.objectContaining({
          createdBy: expect.any(Object),
          _count: expect.objectContaining({
            select: {
              tagProjects: true,
              tagArtifacts: true,
              tagLoops: true,
            },
          }),
        }),
        orderBy: { name: "asc" },
      });
      expect(result).toEqual(tags);
    });
  });

  describe("create", () => {
    it("creates a tag with name and color", async () => {
      const created = makeTag({ name: "Feature", color: "blue" });
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(created),
        },
      };
      mockWithDbCall(mockDb);

      const result = await tagService.create(ORG_ID, USER_ID, {
        name: "Feature",
        color: "blue",
      });

      expect(mockDb.tag.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            organizationId: ORG_ID,
            createdById: USER_ID,
            name: "Feature",
            color: "blue",
          },
        })
      );
      expect(result).toEqual(created);
    });

    it("auto-assigns color from TAG_COLORS palette when not provided", async () => {
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue(null),
          count: vi.fn().mockResolvedValue(3),
          create: vi.fn().mockResolvedValue(makeTag({ color: TAG_COLORS[3] })),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.create(ORG_ID, USER_ID, { name: "NewTag" });

      expect(mockDb.tag.count).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
      });
      expect(mockDb.tag.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            color: TAG_COLORS[3],
          }),
        })
      );
    });

    it("throws DuplicateNameError on case-insensitive name collision", async () => {
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue({ id: "existing-tag" }),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        tagService.create(ORG_ID, USER_ID, { name: "Duplicate" })
      ).rejects.toThrow(DuplicateNameError);

      expect(mockDb.tag.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          name: { equals: "Duplicate", mode: "insensitive" },
        },
        select: { id: true },
      });
    });

    it("creates tag with correct organizationId and createdById", async () => {
      const customOrg = "org-custom";
      const customUser = "user-custom";
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(makeTag()),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.create(customOrg, customUser, {
        name: "Test",
        color: "green",
      });

      expect(mockDb.tag.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: customOrg,
            createdById: customUser,
          }),
        })
      );
    });
  });

  describe("update", () => {
    it("updates tag name", async () => {
      const updated = makeTag({ name: "Renamed" });
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue(updated),
        },
      };
      mockWithDbCall(mockDb);

      const result = await tagService.update(TAG_ID, ORG_ID, {
        name: "Renamed",
      });

      expect(mockDb.tag.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TAG_ID, organizationId: ORG_ID },
          data: { name: "Renamed" },
        })
      );
      expect(result).toEqual(updated);
    });

    it("updates tag color", async () => {
      const updated = makeTag({ color: "purple" });
      const mockDb = {
        tag: {
          update: vi.fn().mockResolvedValue(updated),
        },
      };
      mockWithDbCall(mockDb);

      const result = await tagService.update(TAG_ID, ORG_ID, {
        color: "purple",
      });

      // No name provided, so findFirst for duplicate check should not be called
      expect(mockDb.tag.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TAG_ID, organizationId: ORG_ID },
          data: { color: "purple" },
        })
      );
      expect(result).toEqual(updated);
    });

    it("throws DuplicateNameError when renaming to existing name (case-insensitive)", async () => {
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue({ id: "other-tag" }),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        tagService.update(TAG_ID, ORG_ID, { name: "Existing" })
      ).rejects.toThrow(DuplicateNameError);

      expect(mockDb.tag.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          name: { equals: "Existing", mode: "insensitive" },
          id: { not: TAG_ID },
        },
        select: { id: true },
      });
    });

    it("does not throw when updating a tag and keeping the same name", async () => {
      const mockDb = {
        tag: {
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue(makeTag()),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        tagService.update(TAG_ID, ORG_ID, { name: "Bug" })
      ).resolves.toBeDefined();

      // The findFirst excludes the current tag ID from the collision check
      expect(mockDb.tag.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: TAG_ID },
          }),
        })
      );
    });
  });

  describe("delete", () => {
    it("deletes a tag by id and organizationId", async () => {
      const mockDb = {
        tag: {
          delete: vi.fn().mockResolvedValue(makeTag()),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.delete(TAG_ID, ORG_ID);

      expect(mockDb.tag.delete).toHaveBeenCalledWith({
        where: { id: TAG_ID, organizationId: ORG_ID },
      });
    });
  });

  describe("getArtifactCount", () => {
    it("returns sum of counts across all 3 join tables", async () => {
      const mockDb = {
        tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
        tagProject: { count: vi.fn().mockResolvedValue(2) },
        tagArtifact: { count: vi.fn().mockResolvedValue(5) },
        tagLoop: { count: vi.fn().mockResolvedValue(1) },
      };
      mockWithDbCall(mockDb);

      const result = await tagService.getArtifactCount(TAG_ID, ORG_ID);

      expect(result).toBe(8);
      expect(mockDb.tagProject.count).toHaveBeenCalledWith({
        where: { tagId: TAG_ID },
      });
      expect(mockDb.tagArtifact.count).toHaveBeenCalledWith({
        where: { tagId: TAG_ID },
      });
      expect(mockDb.tagLoop.count).toHaveBeenCalledWith({
        where: { tagId: TAG_ID },
      });
    });
  });

  describe("applyTag", () => {
    const tagOwnershipMock = {
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
    };

    // applyTag wraps validation + write in withDb.tx; the callback relies on
    // the inner withDb() calls (mockWithDbCall) so the passthrough tx just
    // needs to invoke the callback.
    beforeEach(() => {
      mockWithDbTx({});
    });

    it("applies tag to a project", async () => {
      const entityId = "proj-1";
      const mockDb = {
        ...tagOwnershipMock,
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: entityId }),
        },
        tagProject: {
          create: vi
            .fn()
            .mockResolvedValue({ tagId: TAG_ID, projectId: entityId }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.applyTag(
        TAG_ID,
        TagEntityType.Project,
        entityId,
        ORG_ID
      );

      expect(mockDb.project.findFirst).toHaveBeenCalledWith({
        where: { id: entityId, organizationId: ORG_ID },
        select: { id: true },
      });
      expect(mockDb.tagProject.create).toHaveBeenCalledWith({
        data: { tagId: TAG_ID, projectId: entityId },
      });
    });

    it("applies tag to a document artifact", async () => {
      const entityId = "art-1";
      const mockDb = {
        ...tagOwnershipMock,
        artifact: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ id: entityId, type: "DOCUMENT" }),
        },
        tagArtifact: {
          create: vi
            .fn()
            .mockResolvedValue({ tagId: TAG_ID, artifactId: entityId }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.applyTag(
        TAG_ID,
        TagEntityType.Artifact,
        entityId,
        ORG_ID
      );

      expect(mockDb.tagArtifact.create).toHaveBeenCalledWith({
        data: { tagId: TAG_ID, artifactId: entityId },
      });
    });

    it("applies tag to a loop", async () => {
      const entityId = "loop-1";
      const mockDb = {
        ...tagOwnershipMock,
        loop: {
          findFirst: vi.fn().mockResolvedValue({ id: entityId }),
        },
        tagLoop: {
          create: vi
            .fn()
            .mockResolvedValue({ tagId: TAG_ID, loopId: entityId }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.applyTag(TAG_ID, TagEntityType.Loop, entityId, ORG_ID);

      expect(mockDb.tagLoop.create).toHaveBeenCalledWith({
        data: { tagId: TAG_ID, loopId: entityId },
      });
    });

    it("applies tag to a non-document artifact type (e.g. SESSION)", async () => {
      // Tags are common artifact plumbing: any org artifact is taggable
      // (documents, branches, deployments, sessions) — validation is
      // existence + org-scoping only.
      const entityId = "art-session";
      const mockDb = {
        ...tagOwnershipMock,
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: entityId }),
        },
        tagArtifact: {
          create: vi
            .fn()
            .mockResolvedValue({ tagId: TAG_ID, artifactId: entityId }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.applyTag(
        TAG_ID,
        TagEntityType.Artifact,
        entityId,
        ORG_ID
      );

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: { id: entityId, organizationId: ORG_ID },
        select: { id: true },
      });
      expect(mockDb.tagArtifact.create).toHaveBeenCalledWith({
        data: { tagId: TAG_ID, artifactId: entityId },
      });
    });

    it("handles duplicate apply gracefully via P2002 unique constraint", async () => {
      const entityId = "proj-1";
      const p2002Error = Object.assign(new Error("Unique constraint"), {
        code: "P2002",
      });
      const mockDb = {
        ...tagOwnershipMock,
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: entityId }),
        },
        tagProject: {
          create: vi.fn().mockRejectedValue(p2002Error),
        },
      };
      mockWithDbCall(mockDb);

      // Should not throw — P2002 is swallowed as a no-op
      await expect(
        tagService.applyTag(TAG_ID, TagEntityType.Project, entityId, ORG_ID)
      ).resolves.toBeUndefined();
    });

    it("throws EntityNotFoundError when entity does not exist", async () => {
      const mockDb = {
        ...tagOwnershipMock,
        project: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        tagService.applyTag(TAG_ID, TagEntityType.Project, "missing-id", ORG_ID)
      ).rejects.toThrow("PROJECT missing-id not found in this organization");
    });

    it("throws EntityNotFoundError when a concurrent delete trips the FK (P2003)", async () => {
      // Entity passed validation but was deleted before the insert, so the
      // FK no longer resolves. The transaction wrapping the validation +
      // write makes this the only racy outcome left, and we map it to a
      // graceful not-found rather than leaking the raw Prisma error.
      const entityId = "proj-1";
      const p2003Error = Object.assign(new Error("FK constraint"), {
        code: "P2003",
      });
      const mockDb = {
        ...tagOwnershipMock,
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: entityId }),
        },
        tagProject: {
          create: vi.fn().mockRejectedValue(p2003Error),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        tagService.applyTag(TAG_ID, TagEntityType.Project, entityId, ORG_ID)
      ).rejects.toThrow("PROJECT proj-1 not found in this organization");
    });
  });

  describe("removeTag", () => {
    const tagOwnershipMock = {
      tag: { findFirst: vi.fn().mockResolvedValue({ id: TAG_ID }) },
    };

    it("removes tag from a project", async () => {
      const entityId = "proj-1";
      const mockDb = {
        ...tagOwnershipMock,
        tagProject: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.removeTag(
        TAG_ID,
        TagEntityType.Project,
        entityId,
        ORG_ID
      );

      expect(mockDb.tagProject.deleteMany).toHaveBeenCalledWith({
        where: { tagId: TAG_ID, projectId: entityId },
      });
    });

    it("removes tag from an artifact", async () => {
      const entityId = "art-1";
      const mockDb = {
        ...tagOwnershipMock,
        tagArtifact: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.removeTag(
        TAG_ID,
        TagEntityType.Artifact,
        entityId,
        ORG_ID
      );

      expect(mockDb.tagArtifact.deleteMany).toHaveBeenCalledWith({
        where: { tagId: TAG_ID, artifactId: entityId },
      });
    });

    it("removes tag from a loop", async () => {
      const entityId = "loop-1";
      const mockDb = {
        ...tagOwnershipMock,
        tagLoop: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);

      await tagService.removeTag(TAG_ID, TagEntityType.Loop, entityId, ORG_ID);

      expect(mockDb.tagLoop.deleteMany).toHaveBeenCalledWith({
        where: { tagId: TAG_ID, loopId: entityId },
      });
    });

    it("no-op when tag is not applied (deleteMany returns count 0)", async () => {
      const mockDb = {
        ...tagOwnershipMock,
        tagProject: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      mockWithDbCall(mockDb);

      await expect(
        tagService.removeTag(
          TAG_ID,
          TagEntityType.Project,
          "not-applied",
          ORG_ID
        )
      ).resolves.toBeUndefined();
    });
  });
});
