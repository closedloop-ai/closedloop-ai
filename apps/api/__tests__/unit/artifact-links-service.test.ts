import {
  type ArtifactLink,
  ArtifactSubtype,
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PRODUCES admission reads the organization graph and placement state, which
// this suite's database fake does not model; its own coverage is the
// produces-cycle-admission integration suite.
vi.mock("@/app/artifact-links/produces-link-admission", () => ({
  refuseProducesLinkCycle: vi.fn(async () => null),
  refuseProducesLinkDepth: vi.fn(async () => null),
}));

import { mockWithDbAll, mockWithDbCall } from "../utils/db-helpers";

const eligibilityMocks = vi.hoisted(() => ({ findByIds: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn(),
    inTransaction: vi.fn(() => false),
  }),
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

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: eligibilityMocks,
}));

import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { FRONTIER_ID_CHUNK_SIZE } from "@/app/artifact-links/link-tree-traversal";
import { windowForCursor } from "@/app/artifact-links/resolved-page";
import { artifactLinksService } from "@/app/artifact-links/service";
import {
  countPredicateBindParameters,
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";

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
    eligibilityMocks.findByIds.mockResolvedValue(new Map());
  });

  it("projects canonical eligibility onto resolved Branch endpoints", async () => {
    const mockDb = {
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "link-1",
            organizationId: ORG_ID,
            sourceId: "doc-1",
            targetId: "branch-1",
            linkType: LinkType.Produces,
            metadata: null,
            createdAt: new Date("2026-08-18T12:00:00.000Z"),
            source: endpoint("doc-1", null),
            target: endpoint("branch-1", {
              branchName: "feature/eligible",
              baseBranch: "main",
              headSha: null,
              checksStatus: null,
              currentPullRequestDetail: null,
            }),
          },
        ]),
      },
    };
    mockWithDbCall(mockDb);
    eligibilityMocks.findByIds.mockResolvedValue(
      new Map([["branch-1", BranchProductEligibility.Eligible]])
    );

    const { items: result } = await artifactLinksService.findResolvedLinksPage(
      ORG_ID,
      "doc-1",
      LinkDirection.Target,
      windowForCursor()
    );

    expect(result[0]?.target.productEligibility).toBe(
      BranchProductEligibility.Eligible
    );
    expect(result[0]?.source).not.toHaveProperty("productEligibility");
    expect(eligibilityMocks.findByIds).toHaveBeenCalledWith(ORG_ID, [
      "branch-1",
    ]);
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
      mockWithDbAll(mockDb);

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

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: ORG_ID,
            OR: [{ sourceId: "artifact-1" }, { targetId: "artifact-1" }],
          },
          orderBy: { createdAt: "desc" },
        })
      );
    });

    it("adds linkType filter to both OR branches", async () => {
      await artifactLinksService.findLinks(
        ORG_ID,
        "artifact-1",
        LinkType.Produces
      );

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: ORG_ID,
            OR: [
              { sourceId: "artifact-1", linkType: LinkType.Produces },
              { targetId: "artifact-1", linkType: LinkType.Produces },
            ],
          },
          orderBy: { createdAt: "desc" },
        })
      );
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

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: ORG_ID,
            targetId: "artifact-1",
          },
          orderBy: { createdAt: "desc" },
        })
      );
    });

    it("findTargetLinks queries by sourceId (outgoing links)", async () => {
      await artifactLinksService.findTargetLinks(ORG_ID, "artifact-1");

      expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: ORG_ID,
            sourceId: "artifact-1",
          },
          orderBy: { createdAt: "desc" },
        })
      );
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
    /**
     * Drives the real `artifact_links` read rather than spying on a per-node
     * finder. ISS-10041 replaced the per-NODE statement with one per DEPTH
     * LEVEL, so a spy on `findLinksByDirection` now observes a call the
     * traversal no longer makes: it would report zero calls and pin nothing.
     * Each mocked resolution below is therefore one LEVEL, not one node.
     */
    function mockLevelReads(levels: ArtifactLink[][]) {
      const findMany = vi.fn();
      for (const level of levels) {
        findMany.mockResolvedValueOnce(level);
      }
      findMany.mockResolvedValue([]);
      mockWithDbCall({ artifactLink: { findMany } });
      return findMany;
    }

    function whereOfCall(findMany: ReturnType<typeof vi.fn>, index: number) {
      const call = findMany.mock.calls[index] as [
        { where: Record<string, unknown> },
      ];
      return call[0].where;
    }

    it("returns annotated links in a simple chain A→B→C", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkBC = makeLink("l2", "b", "c");
      mockLevelReads([[linkAB], [linkBC]]);

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
      const findMany = mockLevelReads([[linkAB], [linkBA]]);

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
      // `a` is already visited, so the second level enqueues nothing and the
      // walk stops rather than revisiting it forever.
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it("respects maxDepth limit", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkBC = makeLink("l2", "b", "c");
      const findMany = mockLevelReads([[linkAB], [linkBC]]);

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
      // `c` was discovered but never expanded: two levels is the whole budget.
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it("reads one statement per depth level, not one per node (ISS-10041)", async () => {
      const fanOut = [
        makeLink("l1", "a", "b"),
        makeLink("l2", "a", "c"),
        makeLink("l3", "a", "d"),
      ];
      const findMany = mockLevelReads([fanOut]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        10
      );

      expect(result).toEqual([
        { link: fanOut[0], fromArtifactId: "a" },
        { link: fanOut[1], fromArtifactId: "a" },
        { link: fanOut[2], fromArtifactId: "a" },
      ]);
      // The per-node walk would have issued 1 + 3 statements for this graph.
      expect(findMany).toHaveBeenCalledTimes(2);
      // ...and the second is ONE statement naming the whole frontier.
      expect(whereOfCall(findMany, 1)).toEqual({
        organizationId: ORG_ID,
        OR: [
          { sourceId: { in: ["b", "c", "d"] } },
          { targetId: { in: ["b", "c", "d"] } },
        ],
      });
    });

    it("scopes the frontier read by direction and linkType", async () => {
      const findMany = mockLevelReads([[]]);

      await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Target,
        10,
        LinkType.Produces
      );

      // direction=target means "links this artifact is the SOURCE of".
      expect(whereOfCall(findMany, 0)).toEqual({
        organizationId: ORG_ID,
        sourceId: { in: ["a"] },
        linkType: LinkType.Produces,
      });
    });

    it("splits a frontier wider than the bind ceiling without losing order (ISS-10041)", async () => {
      // One over the chunk size, so the level-1 read must split into exactly
      // two statements. This is the bound the production path relies on: one
      // statement this wide is REFUSED by Prisma, taking the request with it.
      const leaves = Array.from(
        { length: FRONTIER_ID_CHUNK_SIZE + 1 },
        (_, i) => `leaf-${i}`
      );
      const firstLeaf = "leaf-0";
      const lastLeaf = `leaf-${FRONTIER_ID_CHUNK_SIZE}`;
      const level0 = leaves.map((leaf, i) => makeLink(`l0-${i}`, "a", leaf));
      // One edge hangs off the FIRST leaf (first chunk) and one off the LAST
      // (second chunk), so a split that dropped either chunk's rows shows up in
      // the RESULT rather than only in the call count.
      const firstChunkLink = makeLink("deep-first", firstLeaf, "x");
      const lastChunkLink = makeLink("deep-last", lastLeaf, "y");
      const findMany = mockLevelReads([
        level0,
        [firstChunkLink],
        [lastChunkLink],
      ]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        2
      );

      // Level 0 is one statement; level 1 is two.
      expect(findMany).toHaveBeenCalledTimes(3);
      const chunkIds = [1, 2].map((index) => {
        const where = whereOfCall(findMany, index) as {
          OR: [{ sourceId: { in: string[] } }, { targetId: { in: string[] } }];
        };
        // `Both` binds the SAME id list twice, once under `sourceId` and once
        // under `targetId` — which is why the chunk gets a HALF share of the
        // budget rather than the whole one.
        expect(where.OR[1].targetId.in).toEqual(where.OR[0].sourceId.in);
        return where.OR[0].sourceId.in;
      });
      expect(chunkIds[0]).toHaveLength(FRONTIER_ID_CHUNK_SIZE);
      expect(chunkIds[1]).toHaveLength(1);
      // The two chunks partition the frontier, in frontier order: no id
      // dropped, none read twice.
      expect([...chunkIds[0], ...chunkIds[1]]).toEqual(leaves);

      // The whole point of the split — every statement it emits stays inside
      // the width a built statement is accepted at.
      for (let index = 0; index < 3; index += 1) {
        expect(
          countPredicateBindParameters(whereOfCall(findMany, index))
        ).toBeLessThanOrEqual(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
      }

      // Order survives the split: level 0 in discovery order, then level 1
      // attributed to its own frontier node, the first chunk's edge ahead of
      // the second chunk's — exactly what an unsplit read would have emitted.
      expect(result).toHaveLength(level0.length + 2);
      expect(result[0]).toEqual({ link: level0[0], fromArtifactId: "a" });
      expect(result.slice(-2)).toEqual([
        { link: firstChunkLink, fromArtifactId: firstLeaf },
        { link: lastChunkLink, fromArtifactId: lastLeaf },
      ]);
    });

    it("deduplicates a link reachable from two frontier nodes", async () => {
      const linkAB = makeLink("l1", "a", "b");
      const linkAC = makeLink("l2", "a", "c");
      // `b` and `c` share an edge, so the level-1 read returns it once and it
      // is attributed to `b` — the earlier node — not emitted twice.
      const linkBC = makeLink("l3", "b", "c");
      const findMany = mockLevelReads([[linkAB, linkAC], [linkBC]]);

      const result = await artifactLinksService.findLinkTree(
        ORG_ID,
        "a",
        LinkDirection.Both,
        10
      );

      expect(result).toEqual([
        { link: linkAB, fromArtifactId: "a" },
        { link: linkAC, fromArtifactId: "a" },
        { link: linkBC, fromArtifactId: "b" },
      ]);
      expect(findMany).toHaveBeenCalledTimes(2);
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

function endpoint(
  id: string,
  branch: {
    baseBranch: string | null;
    branchName: string;
    checksStatus: null;
    currentPullRequestDetail: null;
    headSha: string | null;
  } | null
) {
  return {
    id,
    organizationId: ORG_ID,
    projectId: null,
    type: branch ? ArtifactType.Branch : ArtifactType.Document,
    subtype: branch ? null : ArtifactSubtype.Feature,
    name: id,
    slug: null,
    status: GitHubPRState.Open,
    priority: null,
    assigneeId: null,
    dueDate: null,
    externalUrl: null,
    createdAt: new Date("2026-08-18T12:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2026-08-18T12:00:00.000Z"),
    branch,
  };
}
