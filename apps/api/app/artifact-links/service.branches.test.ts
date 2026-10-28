/**
 * Branch-coverage pins for app/artifact-links/service.ts (ISS-11280),
 * targeting arms not already exercised by the sibling suites under
 * app/artifact-links/__tests__/:
 *  - the optional `linkType` filter arm on findSourceLinks / findTargetLinks
 *    / findResolvedLinksPage.
 *  - findResolvedLinksPage's nextCursor-present page-split arm.
 *  - deleteLink's full branch matrix (no matching row / non-BLOCKS edge /
 *    live BLOCKS edge) — every existing deleteLink reference mocks the
 *    service wholesale (blocks-edge-delete-wiring.test.ts), so the real
 *    function body has never run.
 *  - findLinksByDirection's Source-direction dispatch.
 *  - findDownstreamArtifactIds' getOtherSide "walked from the target side"
 *    arm, plus its own-artifact and duplicate dedup arms.
 *  - findResolvedLinkTreePage's cache-hit, empty-tree, and paginated (with
 *    snapshot) arms.
 *  - matchesArtifactLinkUniqueTarget's non-array P2002 target arm (a
 *    trust-boundary shape Prisma error adapters can produce).
 */
import { randomUUID } from "node:crypto";
import {
  type ArtifactLink,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PRODUCES admission reads the organization graph and placement state, which
// this suite's database fake does not model; its own coverage is the
// produces-cycle-admission integration suite.
vi.mock("@/app/artifact-links/produces-link-admission", () => ({
  refuseProducesLinkCycle: vi.fn(async () => null),
  refuseProducesLinkDepth: vi.fn(async () => null),
}));

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn(),
    inTransaction: () => false,
  }),
  findByIds: vi.fn(),
  readLinkTreePage: vi.fn(),
  saveLinkTreePages: vi.fn(),
  traverseLinkTree: vi.fn(),
  hydrateLinksWithEndpoints: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: {
    DbNull: Symbol("DbNull"),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ join: values }),
  },
}));

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: mocks.findByIds },
}));

vi.mock("./link-tree-pages", () => ({
  readLinkTreePage: mocks.readLinkTreePage,
  saveLinkTreePages: mocks.saveLinkTreePages,
  sweepExpiredLinkTreePages: vi.fn(),
}));

vi.mock("./link-tree-traversal", () => ({
  traverseLinkTree: mocks.traverseLinkTree,
}));

vi.mock("./link-projections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./link-projections")>();
  return {
    ...actual,
    hydrateLinksWithEndpoints: mocks.hydrateLinksWithEndpoints,
  };
});

import { artifactLinksService } from "./service";

const ORG = "org-1";

function withDbReturning(client: Record<string, unknown>) {
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(client));
}

function makeLink(overrides: Partial<ArtifactLink> = {}): ArtifactLink {
  return {
    id: randomUUID(),
    organizationId: ORG,
    sourceId: "artifact-a",
    targetId: "artifact-b",
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Minimal endpoint fixture: only the fields toArtifactLinkEndpoint reads. */
function makeEndpoint(id: string) {
  return { id, subtype: null, branch: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIds.mockResolvedValue(new Map());
});

describe("findSourceLinks / findTargetLinks — linkType filter", () => {
  it("findSourceLinks includes linkType in the where clause when provided", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findSourceLinks(
      ORG,
      "artifact-1",
      LinkType.Blocks
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          targetId: "artifact-1",
          linkType: LinkType.Blocks,
        },
      })
    );
  });

  it("findTargetLinks includes linkType in the where clause when provided", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findTargetLinks(
      ORG,
      "artifact-1",
      LinkType.Blocks
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          sourceId: "artifact-1",
          linkType: LinkType.Blocks,
        },
      })
    );
  });
});

describe("findResolvedLinksPage — linkType filter and pagination cursor", () => {
  it("includes linkType in the where clause when provided", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findResolvedLinksPage(
      ORG,
      "artifact-1",
      LinkDirection.Both,
      { skip: 0, take: 1001 },
      LinkType.Blocks
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ linkType: LinkType.Blocks }),
      })
    );
  });

  it("returns a nextCursor when the peeked window exceeds one page", async () => {
    // ARTIFACT_LINK_PAGE_SIZE is 1000; a peeked window of 1001 rows means one
    // page (1000) plus a lookahead row, so splitPeekedPage must report a cursor.
    const peeked = Array.from({ length: 1001 }, (_, i) => ({
      ...makeLink({ id: `link-${i}` }),
      source: makeEndpoint("artifact-1"),
      target: makeEndpoint(`artifact-${i}`),
    }));
    const findMany = vi.fn().mockResolvedValue(peeked);
    withDbReturning({ artifactLink: { findMany } });

    const result = await artifactLinksService.findResolvedLinksPage(
      ORG,
      "artifact-1",
      LinkDirection.Both,
      { skip: 0, take: 1001 }
    );

    expect(result.items).toHaveLength(1000);
    expect(result.nextCursor).toBe("1000");
  });

  it("omits nextCursor entirely (not null) when the peeked window fits in one page", async () => {
    const peeked = [
      {
        ...makeLink(),
        source: makeEndpoint("artifact-a"),
        target: makeEndpoint("artifact-b"),
      },
    ];
    const findMany = vi.fn().mockResolvedValue(peeked);
    withDbReturning({ artifactLink: { findMany } });

    const result = await artifactLinksService.findResolvedLinksPage(
      ORG,
      "artifact-a",
      LinkDirection.Both,
      { skip: 0, take: 2 }
    );

    expect(result.items).toHaveLength(1);
    expect("nextCursor" in result).toBe(false);
  });
});

describe("deleteLink — full branch matrix", () => {
  it("reports no unblock candidates when the delete matched no row", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    mocks.withDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({ artifactLink: { findFirst, deleteMany } })
    );

    const result = await artifactLinksService.deleteLink("link-1", ORG);

    expect(result).toEqual({ unblockCandidateIds: [], deleted: false });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "link-1", organizationId: ORG },
    });
  });

  it("reports no unblock candidates when the deleted link was not a BLOCKS edge", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      targetId: "dependent-1",
      linkType: LinkType.Produces,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    // The PRODUCES target is not a branch, so no evidence is derived.
    mocks.withDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({
        artifactLink: { findFirst, deleteMany },
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    );

    const result = await artifactLinksService.deleteLink("link-1", ORG);

    expect(result).toEqual({ unblockCandidateIds: [], deleted: true });
  });

  it("names the target as an unblock candidate for a deleted BLOCKS edge", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      targetId: "dependent-1",
      linkType: LinkType.Blocks,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.withDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({ artifactLink: { findFirst, deleteMany } })
    );

    const result = await artifactLinksService.deleteLink("link-1", ORG);

    expect(result).toEqual({
      unblockCandidateIds: ["dependent-1"],
      deleted: true,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "link-1", organizationId: ORG },
      select: { targetId: true, linkType: true },
    });
  });

  it("reports no candidates on a zero-count delete even when the pre-delete read found a live BLOCKS edge", async () => {
    // Isolates the `count === 0` half of the `||`: if it did not short-circuit,
    // `link.linkType !== LinkType.Blocks` here would be false too (the read DID
    // find a Blocks edge), so a mutant that drops the count check would flip
    // this to `{ unblockCandidateIds: ["dependent-1"] }`.
    const findFirst = vi.fn().mockResolvedValue({
      targetId: "dependent-1",
      linkType: LinkType.Blocks,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    mocks.withDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({ artifactLink: { findFirst, deleteMany } })
    );

    const result = await artifactLinksService.deleteLink("link-1", ORG);

    expect(result).toEqual({ unblockCandidateIds: [], deleted: false });
  });

  it("does not throw reading linkType off a null pre-delete read when the delete still matched a row", async () => {
    // Isolates the optional-chaining on `link?.linkType`: a non-optional
    // `link.linkType` would throw on this null `link`, since `count === 0`
    // is false here and the right operand IS evaluated.
    const findFirst = vi.fn().mockResolvedValue(null);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.withDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({ artifactLink: { findFirst, deleteMany } })
    );

    await expect(
      artifactLinksService.deleteLink("link-1", ORG)
    ).resolves.toEqual({ unblockCandidateIds: [], deleted: true });
  });
});

describe("findLinksByDirection — Source direction dispatch", () => {
  it("delegates to findSourceLinks (queries by targetId) for LinkDirection.Source", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findLinksByDirection(
      ORG,
      "artifact-1",
      LinkDirection.Source
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, targetId: "artifact-1" },
      })
    );
  });
});

describe("findResolvedLinksPage — buildDirectionFilter's Source and Target arms", () => {
  it("filters by targetId (not an OR of both sides) for LinkDirection.Source", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findResolvedLinksPage(
      ORG,
      "artifact-1",
      LinkDirection.Source,
      { skip: 0, take: 10 }
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetId: "artifact-1" }),
      })
    );
    const call = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.OR).toBeUndefined();
    expect(call.where.sourceId).toBeUndefined();
  });

  it("filters by sourceId (not an OR of both sides) for LinkDirection.Target", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findResolvedLinksPage(
      ORG,
      "artifact-1",
      LinkDirection.Target,
      { skip: 0, take: 10 }
    );

    const call = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.sourceId).toBe("artifact-1");
    expect(call.where.OR).toBeUndefined();
    expect(call.where.targetId).toBeUndefined();
  });

  it("falls through both direction checks to the OR-of-both-sides filter for LinkDirection.Both", async () => {
    // A mutant that forces either `direction === Source` or `direction ===
    // Target` permanently true would make a Both-direction call fall into
    // one of those single-sided branches instead of reaching this OR — the
    // sibling nextCursor tests below never inspect `where`, so only this
    // test's shape assertion catches it.
    const findMany = vi.fn().mockResolvedValue([]);
    withDbReturning({ artifactLink: { findMany } });

    await artifactLinksService.findResolvedLinksPage(
      ORG,
      "artifact-1",
      LinkDirection.Both,
      { skip: 0, take: 10 }
    );

    const call = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.OR).toEqual([
      { sourceId: "artifact-1" },
      { targetId: "artifact-1" },
    ]);
    expect(call.where.sourceId).toBeUndefined();
    expect(call.where.targetId).toBeUndefined();
  });
});

describe("findDownstreamArtifactIds — getOtherSide + dedup", () => {
  it("resolves the other side when walking from a link's target, drops the start artifact and de-dupes repeats", async () => {
    const startId = "root";
    const linkFromSource = {
      link: makeLink({ sourceId: startId, targetId: "child-1" }),
      fromArtifactId: startId,
    };
    // Walked from the TARGET side (fromArtifactId === link.targetId): the
    // false arm of the `sourceId === fromArtifactId` ternary.
    const linkFromTarget = {
      link: makeLink({ sourceId: "child-2", targetId: "child-1" }),
      fromArtifactId: "child-1",
    };
    // Points back at the traversal's own start artifact — must be excluded.
    const backToStart = {
      link: makeLink({ sourceId: "child-2", targetId: startId }),
      fromArtifactId: "child-2",
    };
    // A repeat of "child-1", already collected via linkFromSource — dedup arm.
    const duplicate = {
      link: makeLink({ sourceId: startId, targetId: "child-1" }),
      fromArtifactId: startId,
    };
    mocks.traverseLinkTree.mockResolvedValue([
      linkFromSource,
      linkFromTarget,
      backToStart,
      duplicate,
    ]);

    const result = await artifactLinksService.findDownstreamArtifactIds(
      ORG,
      startId
    );

    expect(result).toEqual(["child-1", "child-2"]);
  });
});

describe("findResolvedLinkTreePage — cache / empty-tree / paginated-with-snapshot", () => {
  it("hydrates and returns a cached tree page without re-traversing", async () => {
    const cachedLink = makeLink({ id: "cached-link" });
    mocks.readLinkTreePage.mockResolvedValue({
      pageLinks: [cachedLink],
      nextCursor: "50",
    });
    mocks.hydrateLinksWithEndpoints.mockResolvedValue([
      {
        ...cachedLink,
        source: makeEndpoint("artifact-a"),
        target: makeEndpoint("artifact-b"),
      },
    ]);

    const result = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      "artifact-1",
      LinkDirection.Both,
      10,
      { skip: 50, take: 10 }
    );

    expect(mocks.traverseLinkTree).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe("50");
  });

  it("returns an empty page without saving a snapshot when the tree has no links", async () => {
    mocks.readLinkTreePage.mockResolvedValue(null);
    mocks.traverseLinkTree.mockResolvedValue([]);

    const result = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      "artifact-1",
      LinkDirection.Both,
      10,
      { skip: 0, take: 10 }
    );

    expect(result).toEqual({ items: [] });
    expect(mocks.saveLinkTreePages).not.toHaveBeenCalled();
    expect(mocks.hydrateLinksWithEndpoints).not.toHaveBeenCalled();
  });

  it("carries a snapshotId onto a paginated (non-final) tree page", async () => {
    mocks.readLinkTreePage.mockResolvedValue(null);
    // findResolvedLinkTreePage slices `links.slice(skip, skip + take)` and
    // hands that slice straight to splitPeekedPage — unlike
    // findResolvedLinksPage, there's no "peek one extra row" here, so a
    // cursor only appears when the slice itself exceeds
    // ARTIFACT_LINK_PAGE_SIZE (1000). 1001 total links + take=1001 gets there.
    const annotated = Array.from({ length: 1001 }, (_, i) => ({
      link: makeLink({ id: `link-${i}` }),
      fromArtifactId: "artifact-1",
    }));
    mocks.traverseLinkTree.mockResolvedValue(annotated);
    mocks.saveLinkTreePages.mockResolvedValue("snapshot-xyz");
    mocks.hydrateLinksWithEndpoints.mockResolvedValue([
      {
        ...annotated[0].link,
        source: makeEndpoint("a"),
        target: makeEndpoint("b"),
      },
    ]);

    const result = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      "artifact-1",
      LinkDirection.Both,
      10,
      { skip: 0, take: 1001 }
    );

    expect(result).toEqual(
      expect.objectContaining({
        nextCursor: "1000",
        snapshotId: "snapshot-xyz",
      })
    );
  });
});

describe("createLink — non-array, non-string P2002 target (malformed adapter shape)", () => {
  it("re-throws rather than reporting Conflict when meta.target is neither a string nor an array", async () => {
    const p2002Error = Object.assign(new Error("unique constraint"), {
      code: "P2002",
      meta: { target: { unexpected: "shape" } },
    });
    const artifactFindMany = vi.fn().mockResolvedValue([
      { id: "artifact-a", projectId: null },
      { id: "artifact-b", projectId: null },
    ]);
    const create = vi.fn().mockRejectedValue(p2002Error);
    mocks.withDb.tx.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback({
        artifact: {
          findMany: artifactFindMany,
          findFirst: vi.fn().mockResolvedValue(null),
        },
        artifactLink: {
          create,
          aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      })
    );

    await expect(
      artifactLinksService.createLink(ORG, {
        sourceId: "artifact-a",
        targetId: "artifact-b",
        linkType: LinkType.Produces,
      })
    ).rejects.toBe(p2002Error);
  });
});
