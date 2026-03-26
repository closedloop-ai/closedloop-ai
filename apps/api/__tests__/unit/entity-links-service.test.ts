import {
  type EntityLink,
  type EntityType,
  LinkType,
} from "@repo/api/src/types/entity-link";
import { vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
  EntityType: {
    ARTIFACT: "ARTIFACT",
    FEATURE: "FEATURE",
    EXTERNAL_LINK: "EXTERNAL_LINK",
  },
}));

import { entityLinksService } from "@/app/entity-links/service";

const ORG_ID = "org-1";

function makeLink(
  id: string,
  sourceId: string,
  sourceType: EntityType,
  targetId: string,
  targetType: EntityType,
  linkType: LinkType = LinkType.Produces
): EntityLink {
  return {
    id,
    organizationId: ORG_ID,
    sourceId,
    sourceType,
    targetId,
    targetType,
    sourceVersion: null,
    targetVersion: null,
    linkType,
    metadata: null,
    createdAt: new Date(),
  };
}

describe("entityLinksService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createLink metadata handling", () => {
    it.each([
      { label: "null", metadata: null },
      { label: "undefined", metadata: undefined },
    ])("uses DbNull when metadata is $label", async ({ metadata }) => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "a-1" }),
        },
        entityLink: {
          create: vi.fn().mockResolvedValue({ id: "el-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await entityLinksService.createLink(ORG_ID, {
        sourceId: "a-1",
        sourceType: "ARTIFACT" as const,
        targetId: "a-2",
        targetType: "ARTIFACT" as const,
        linkType: "RELATES_TO" as const,
        ...(metadata !== undefined && { metadata }),
      });

      expect(mockDb.entityLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          metadata: "DbNull",
        }),
      });
    });
  });

  describe("findLinks builds bidirectional OR query", () => {
    let mockDb: { entityLink: { findMany: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
      mockDb = {
        entityLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);
    });

    it("queries both source and target sides", async () => {
      await entityLinksService.findLinks(ORG_ID, "artifact-1", "ARTIFACT");

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          OR: [
            { sourceId: "artifact-1", sourceType: "ARTIFACT" },
            { targetId: "artifact-1", targetType: "ARTIFACT" },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("adds linkType filter to both OR branches", async () => {
      await entityLinksService.findLinks(
        ORG_ID,
        "artifact-1",
        "ARTIFACT",
        "PRODUCES"
      );

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
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
    let mockDb: { entityLink: { findMany: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
      mockDb = {
        entityLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);
    });

    it("findSourceLinks queries by targetId (incoming links)", async () => {
      await entityLinksService.findSourceLinks(
        ORG_ID,
        "artifact-1",
        "ARTIFACT"
      );

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          targetId: "artifact-1",
          targetType: "ARTIFACT",
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("findTargetLinks queries by sourceId (outgoing links)", async () => {
      await entityLinksService.findTargetLinks(
        ORG_ID,
        "artifact-1",
        "ARTIFACT"
      );

      expect(mockDb.entityLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          sourceId: "artifact-1",
          sourceType: "ARTIFACT",
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("resolveEntity dispatches by type", () => {
    it("resolves ARTIFACT with assignee/approver includes", async () => {
      const mockArtifact = { id: "a-1", title: "My PRD" };
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue(mockArtifact),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity(
        ORG_ID,
        "a-1",
        "ARTIFACT"
      );

      expect(result).toEqual({ type: "ARTIFACT", entity: mockArtifact });
      expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: "a-1", organizationId: ORG_ID },
        include: {
          assignee: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
          approver: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      });
    });

    it("resolves FEATURE with assignee/createdBy includes", async () => {
      const mockFeature = { id: "i-1", title: "Bug report" };
      const mockDb = {
        feature: {
          findUnique: vi.fn().mockResolvedValue(mockFeature),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity(
        ORG_ID,
        "i-1",
        "FEATURE"
      );

      expect(result).toEqual({ type: "FEATURE", entity: mockFeature });
      expect(mockDb.feature.findUnique).toHaveBeenCalledWith({
        where: { id: "i-1", organizationId: ORG_ID },
        include: {
          assignee: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              email: true,
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
        ORG_ID,
        "el-1",
        "EXTERNAL_LINK"
      );

      expect(result).toEqual({ type: "EXTERNAL_LINK", entity: mockLink });
      expect(mockDb.externalLink.findUnique).toHaveBeenCalledWith({
        where: { id: "el-1", organizationId: ORG_ID },
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
        ORG_ID,
        "nonexistent",
        "ARTIFACT"
      );

      expect(result).toBeNull();
    });

    it("returns null for unknown entity type", async () => {
      const mockDb = {};
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveEntity(
        ORG_ID,
        "x-1",
        "UNKNOWN" as any
      );

      expect(result).toBeNull();
    });
  });

  describe("resolveLinkedEntities", () => {
    it("resolves the 'other' entity on each link", async () => {
      const linkAB = makeLink("l1", "a", "ARTIFACT", "b", "FEATURE");
      const mockFeature = { id: "b", title: "Bug report" };
      const mockDb = {
        feature: {
          findUnique: vi.fn().mockResolvedValue(mockFeature),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveLinkedEntities(ORG_ID, [
        { link: linkAB, fromEntityId: "a" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].resolvedEntity).toEqual({
        type: "FEATURE",
        entity: mockFeature,
      });
    });

    it("resolves source when known entity is on the target side", async () => {
      const link = makeLink("l1", "a", "ARTIFACT", "b", "FEATURE");
      const mockArtifact = { id: "a", title: "My PRD" };
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue(mockArtifact),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveLinkedEntities(ORG_ID, [
        { link, fromEntityId: "b" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].resolvedEntity).toEqual({
        type: "ARTIFACT",
        entity: mockArtifact,
      });
    });

    it("deduplicates entities appearing in multiple links", async () => {
      const link1 = makeLink("l1", "a", "ARTIFACT", "b", "FEATURE");
      const link2 = makeLink("l2", "c", "ARTIFACT", "b", "FEATURE");
      const mockFeature = { id: "b", title: "Shared feature" };
      const mockDb = {
        feature: {
          findUnique: vi.fn().mockResolvedValue(mockFeature),
        },
        artifact: {
          findUnique: vi.fn().mockResolvedValue({ id: "c", title: "Other" }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveLinkedEntities(ORG_ID, [
        { link: link1, fromEntityId: "a" },
        { link: link2, fromEntityId: "c" },
      ]);

      expect(result).toHaveLength(2);
      // b:FEATURE should only be resolved once
      expect(mockDb.feature.findUnique).toHaveBeenCalledTimes(1);
    });

    it("returns null for missing entities", async () => {
      const link = makeLink("l1", "a", "ARTIFACT", "b", "FEATURE");
      const mockDb = {
        feature: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveLinkedEntities(ORG_ID, [
        { link, fromEntityId: "a" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].resolvedEntity).toBeNull();
    });

    it("resolves correct entity at each hop in a tree traversal", async () => {
      // Chain: A→B→C. fromEntityId tracks which BFS node found each link.
      const linkAB = makeLink("l1", "a", "ARTIFACT", "b", "ARTIFACT");
      const linkBC = makeLink("l2", "b", "ARTIFACT", "c", "FEATURE");
      const mockArtifactB = { id: "b", title: "Plan" };
      const mockFeatureC = { id: "c", title: "Bug" };
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue(mockArtifactB),
        },
        feature: {
          findUnique: vi.fn().mockResolvedValue(mockFeatureC),
        },
      };
      mockWithDbCall(mockDb);

      const result = await entityLinksService.resolveLinkedEntities(ORG_ID, [
        { link: linkAB, fromEntityId: "a" }, // A discovered A→B, resolve B
        { link: linkBC, fromEntityId: "b" }, // B discovered B→C, resolve C
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].resolvedEntity).toEqual({
        type: "ARTIFACT",
        entity: mockArtifactB,
      });
      expect(result[1].resolvedEntity).toEqual({
        type: "FEATURE",
        entity: mockFeatureC,
      });
    });
  });

  describe("findLinkTree", () => {
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spy = vi.spyOn(entityLinksService, "findLinksByDirection");
    });

    afterEach(() => {
      spy.mockRestore();
    });

    it("returns annotated links in a simple chain A→B→C", async () => {
      const linkAB = makeLink("l1", "a", "ARTIFACT", "b", "ARTIFACT");
      const linkBC = makeLink("l2", "b", "ARTIFACT", "c", "ARTIFACT");

      spy
        .mockResolvedValueOnce([linkAB]) // query from A
        .mockResolvedValueOnce([linkBC]) // query from B
        .mockResolvedValueOnce([]); // query from C

      const result = await entityLinksService.findLinkTree(
        ORG_ID,
        "a",
        "ARTIFACT",
        "both",
        10
      );

      expect(result).toEqual([
        { link: linkAB, fromEntityId: "a" },
        { link: linkBC, fromEntityId: "b" },
      ]);
    });

    it("handles cycles without infinite loops", async () => {
      const linkAB = makeLink("l1", "a", "ARTIFACT", "b", "ARTIFACT");
      const linkBA = makeLink("l2", "b", "ARTIFACT", "a", "ARTIFACT");

      spy
        .mockResolvedValueOnce([linkAB]) // query from A: finds A→B
        .mockResolvedValueOnce([linkBA]); // query from B: finds B→A (but A already visited)

      const result = await entityLinksService.findLinkTree(
        ORG_ID,
        "a",
        "ARTIFACT",
        "both",
        10
      );

      expect(result).toEqual([
        { link: linkAB, fromEntityId: "a" },
        { link: linkBA, fromEntityId: "b" },
      ]);
      // A was already visited so BFS does not re-enqueue it
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("respects maxDepth limit", async () => {
      const linkAB = makeLink("l1", "a", "ARTIFACT", "b", "ARTIFACT");
      const linkBC = makeLink("l2", "b", "ARTIFACT", "c", "ARTIFACT");

      spy
        .mockResolvedValueOnce([linkAB]) // depth 0: query from A
        .mockResolvedValueOnce([linkBC]); // depth 1: query from B (but C is at depth 2, won't be queried)

      const result = await entityLinksService.findLinkTree(
        ORG_ID,
        "a",
        "ARTIFACT",
        "both",
        2
      );

      expect(result).toEqual([
        { link: linkAB, fromEntityId: "a" },
        { link: linkBC, fromEntityId: "b" },
      ]);
      // Only A (depth 0) and B (depth 1) are queried; C at depth 2 is not expanded
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("passes direction through to findLinksByDirection", async () => {
      spy.mockResolvedValueOnce([]);

      await entityLinksService.findLinkTree(
        ORG_ID,
        "a",
        "ARTIFACT",
        "target",
        10,
        "PRODUCES"
      );

      expect(spy).toHaveBeenCalledWith(
        ORG_ID,
        "a",
        "ARTIFACT",
        "target",
        "PRODUCES"
      );
    });

    it("traverses across entity types", async () => {
      const linkArtFeature = makeLink("l1", "a", "ARTIFACT", "i", "FEATURE");
      const linkFeatureExt = makeLink(
        "l2",
        "i",
        "FEATURE",
        "e",
        "EXTERNAL_LINK"
      );

      spy
        .mockResolvedValueOnce([linkArtFeature]) // query from ARTIFACT a
        .mockResolvedValueOnce([linkFeatureExt]) // query from FEATURE i
        .mockResolvedValueOnce([]); // query from EXTERNAL_LINK e

      const result = await entityLinksService.findLinkTree(
        ORG_ID,
        "a",
        "ARTIFACT",
        "both",
        10
      );

      expect(result).toEqual([
        { link: linkArtFeature, fromEntityId: "a" },
        { link: linkFeatureExt, fromEntityId: "i" },
      ]);
    });

    it("deduplicates links seen from multiple entities", async () => {
      const linkAB = makeLink("l1", "a", "ARTIFACT", "b", "ARTIFACT");

      // Both A and B return the same link record
      spy
        .mockResolvedValueOnce([linkAB]) // query from A
        .mockResolvedValueOnce([linkAB]); // query from B (same link, already collected)

      const result = await entityLinksService.findLinkTree(
        ORG_ID,
        "a",
        "ARTIFACT",
        "both",
        10
      );

      expect(result).toEqual([{ link: linkAB, fromEntityId: "a" }]);
    });
  });
});
