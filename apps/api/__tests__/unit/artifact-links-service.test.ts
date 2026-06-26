import {
  type ArtifactLink,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  LinkType: {
    PRODUCES: "PRODUCES",
    BLOCKS: "BLOCKS",
    RELATES_TO: "RELATES_TO",
  },
}));

import { artifactLinksService } from "@/app/artifact-links/service";

const ORG_ID = "org-1";

function makeLink(
  id: string,
  sourceId: string,
  targetId: string,
  linkType: LinkType = LinkType.Produces
): ArtifactLink {
  return {
    id,
    organizationId: ORG_ID,
    sourceId,
    targetId,
    linkType,
    metadata: null,
    createdAt: new Date(),
  };
}

describe("artifactLinksService", () => {
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
        artifactLink: {
          create: vi.fn().mockResolvedValue({
            id: "al-1",
            organizationId: ORG_ID,
            sourceId: "a-1",
            targetId: "a-2",
            linkType: LinkType.RelatesTo,
            metadata: null,
            createdAt: new Date(),
          }),
        },
      };
      mockWithDbCall(mockDb);

      await artifactLinksService.createLink(ORG_ID, {
        sourceId: "a-1",
        targetId: "a-2",
        linkType: LinkType.RelatesTo,
        ...(metadata !== undefined && { metadata }),
      });

      expect(mockDb.artifactLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          sourceId: "a-1",
          targetId: "a-2",
          linkType: LinkType.RelatesTo,
          metadata: "DbNull",
        }),
      });
    });
  });

  describe("findLinks builds bidirectional OR query", () => {
    let mockDb: { artifactLink: { findMany: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
      mockDb = {
        artifactLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);
    });

    it("queries both source and target sides", async () => {
      await artifactLinksService.findLinks(ORG_ID, "artifact-1");

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          OR: [{ sourceId: "artifact-1" }, { targetId: "artifact-1" }],
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("adds linkType filter to both OR branches", async () => {
      await artifactLinksService.findLinks(
        ORG_ID,
        "artifact-1",
        LinkType.Produces
      );

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          OR: [
            { sourceId: "artifact-1", linkType: LinkType.Produces },
            { targetId: "artifact-1", linkType: LinkType.Produces },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("directional queries", () => {
    let mockDb: { artifactLink: { findMany: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
      mockDb = {
        artifactLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);
    });

    it("findSourceLinks queries by targetId (incoming links)", async () => {
      await artifactLinksService.findSourceLinks(ORG_ID, "artifact-1");

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          targetId: "artifact-1",
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("findTargetLinks queries by sourceId (outgoing links)", async () => {
      await artifactLinksService.findTargetLinks(ORG_ID, "artifact-1");

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          sourceId: "artifact-1",
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("findLinksByDirection dispatches correctly", () => {
    it("dispatches to findSourceLinks for direction=source", async () => {
      const spy = vi.spyOn(artifactLinksService, "findSourceLinks");
      spy.mockResolvedValueOnce([]);

      await artifactLinksService.findLinksByDirection(
        ORG_ID,
        "artifact-1",
        LinkDirection.Source,
        LinkType.Produces
      );

      expect(spy).toHaveBeenCalledWith(ORG_ID, "artifact-1", LinkType.Produces);
      spy.mockRestore();
    });

    it("dispatches to findTargetLinks for direction=target", async () => {
      const spy = vi.spyOn(artifactLinksService, "findTargetLinks");
      spy.mockResolvedValueOnce([]);

      await artifactLinksService.findLinksByDirection(
        ORG_ID,
        "artifact-1",
        LinkDirection.Target
      );

      expect(spy).toHaveBeenCalledWith(ORG_ID, "artifact-1", undefined);
      spy.mockRestore();
    });

    it("dispatches to findLinks for direction=both", async () => {
      const spy = vi.spyOn(artifactLinksService, "findLinks");
      spy.mockResolvedValueOnce([]);

      await artifactLinksService.findLinksByDirection(
        ORG_ID,
        "artifact-1",
        LinkDirection.Both
      );

      expect(spy).toHaveBeenCalledWith(ORG_ID, "artifact-1", undefined);
      spy.mockRestore();
    });
  });

  describe("findLinkTree (BFS traversal)", () => {
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spy = vi.spyOn(artifactLinksService, "findLinksByDirection");
    });

    afterEach(() => {
      spy.mockRestore();
    });

    it("returns annotated links in a simple chain A→B→C", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkBC = makeLink("l2", "b", "c");

      spy
        .mockResolvedValueOnce([linkAB])
        .mockResolvedValueOnce([linkBC])
        .mockResolvedValueOnce([]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        10
      );

      expect(result).toEqual([
        { link: linkAB, fromArtifactId: "a" },
        { link: linkBC, fromArtifactId: "b" },
      ]);
    });

    it("handles cycles without infinite loops", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkBA = makeLink("l2", "b", "a");

      spy.mockResolvedValueOnce([linkAB]).mockResolvedValueOnce([linkBA]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        10
      );

      expect(result).toEqual([
        { link: linkAB, fromArtifactId: "a" },
        { link: linkBA, fromArtifactId: "b" },
      ]);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("respects maxDepth limit", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkBC = makeLink("l2", "b", "c");

      spy.mockResolvedValueOnce([linkAB]).mockResolvedValueOnce([linkBC]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        2
      );

      expect(result).toEqual([
        { link: linkAB, fromArtifactId: "a" },
        { link: linkBC, fromArtifactId: "b" },
      ]);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("passes direction and linkType through to findLinksByDirection", async () => {
      spy.mockResolvedValueOnce([]);

      await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Target,
        10,
        LinkType.Produces
      );

      expect(spy).toHaveBeenCalledWith(
        ORG_ID,
        "a",
        LinkDirection.Target,
        LinkType.Produces
      );
    });

    it("deduplicates links seen from multiple artifacts", async () => {
      const linkAB = makeLink("l1", "a", "b");

      spy.mockResolvedValueOnce([linkAB]).mockResolvedValueOnce([linkAB]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        10
      );

      expect(result).toEqual([{ link: linkAB, fromArtifactId: "a" }]);
    });
  });

  describe("findDownstreamArtifactIds", () => {
    let findLinkTreeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      findLinkTreeSpy = vi.spyOn(artifactLinksService, "findLinkTree");
    });

    afterEach(() => {
      findLinkTreeSpy.mockRestore();
    });

    it("returns downstream artifact ids from a chain, excluding the root", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkBC = makeLink("l2", "b", "c");

      findLinkTreeSpy.mockResolvedValueOnce([
        { link: linkAB, fromArtifactId: "a" },
        { link: linkBC, fromArtifactId: "b" },
      ]);

      const result = await artifactLinksService.findDownstreamArtifactIds(
        ORG_ID,
        "a"
      );

      expect(result).toEqual(["b", "c"]);
    });

    it("returns empty array when no downstream artifacts exist", async () => {
      findLinkTreeSpy.mockResolvedValueOnce([]);

      const result = await artifactLinksService.findDownstreamArtifactIds(
        ORG_ID,
        "a"
      );

      expect(result).toEqual([]);
    });
  });
});
