import { randomUUID } from "node:crypto";
import { LinkDirection, LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLegacyProducesLinks } from "@/__tests__/support/artifact-links/legacy-produces-cycle.test-helpers";
import { seedPagedTree } from "@/__tests__/support/artifact-links/tree-pages.test-fixtures";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import { sweepExpiredLinkTreePages } from "../link-tree-pages";
import { windowForCursor } from "../resolved-page";
import { artifactLinksService } from "../service";

const organizations: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  const ids = organizations.splice(0);
  await withDb((db) =>
    db.artifactLink.deleteMany({ where: { organizationId: { in: ids } } })
  );
  await withDb((db) =>
    db.artifact.deleteMany({ where: { organizationId: { in: ids } } })
  );
  await withDb((db) =>
    db.organization.deleteMany({ where: { id: { in: ids } } })
  );
});

async function seed() {
  const graph = await seedPagedTree();
  organizations.push(graph.organizationId);
  return graph;
}

async function allPages(
  graph: Awaited<ReturnType<typeof seed>>,
  direction: LinkDirection = LinkDirection.Both,
  maxDepth = 5,
  legacy = false
) {
  const ids: string[] = [];
  let cursor: number | undefined;
  let snapshotId: string | undefined;
  do {
    const page = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      direction,
      maxDepth,
      windowForCursor(cursor, legacy ? undefined : snapshotId)
    );
    ids.push(...page.items.map((link) => link.id));
    cursor =
      page.nextCursor === undefined ? undefined : Number(page.nextCursor);
    snapshotId = page.snapshotId;
  } while (cursor !== undefined);
  return ids;
}

describe("tree continuation on PostgreSQL", () => {
  it("two readers each traverse once and concatenate complete ordered pages", async () => {
    const graph = await seed();
    const walk = vi.spyOn(artifactLinksService, "findLinkTree");
    const [first, second] = await Promise.all([
      allPages(graph),
      allPages(graph),
    ]);
    expect(first).toEqual(graph.expected);
    expect(second).toEqual(graph.expected);
    expect(new Set(first).size).toBe(3300);
    expect(walk).toHaveBeenCalledTimes(2);
    expect(
      await withDb((db) =>
        db.artifactLinkTreePage.count({
          where: { organizationId: graph.organizationId, offset: 0 },
        })
      )
    ).toBe(0);
    expect(
      await withDb((db) =>
        db.artifactLinkTreePage.count({
          where: { organizationId: graph.organizationId },
        })
      )
    ).toBe(6);
  });

  it("returns the traversed page and can resume numerically after a snapshot write timeout", async () => {
    const graph = await seed();
    const model = await withDb((db) => db.artifactLinkTreePage);
    const write = vi
      .spyOn(model, "createMany")
      .mockRejectedValueOnce({ code: "P2024" });
    const first = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor()
    );
    expect(first.items.map((link) => link.id)).toEqual(
      graph.expected.slice(0, 1000)
    );
    expect(first.snapshotId).toBeUndefined();
    expect(first.nextCursor).toBe("1000");
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
    const second = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor(Number(first.nextCursor))
    );
    expect(second.items.map((link) => link.id)).toEqual(
      graph.expected.slice(1000, 2000)
    );
    expect(second.snapshotId).toBeDefined();
  });

  it("commits expired-page batches before a later failure and resumes without deleting live pages", async () => {
    const organizationId = await createTestOrganization();
    organizations.push(organizationId);
    const snapshotId = randomUUID();
    const expired = new Date(Date.now() - 1000);
    await withDb((db) =>
      db.artifactLinkTreePage.createMany({
        data: Array.from({ length: 2002 }, (_, index) => ({
          snapshotId,
          organizationId,
          offset: index * 1000,
          queryKey: "retention-test",
          linkIds: [],
          hasMore: false,
          expiresAt:
            index === 2001 ? new Date(Date.now() + 86_400_000) : expired,
        })),
      })
    );
    const model = await withDb((db) => db.artifactLinkTreePage);
    const remove = model.deleteMany.bind(model);
    const failure = new Error("second batch statement timeout");
    const spy = vi
      .spyOn(model, "deleteMany")
      .mockImplementationOnce((args) => remove(args))
      .mockRejectedValueOnce(failure);
    await expect(sweepExpiredLinkTreePages()).rejects.toBe(failure);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect(
      await withDb((db) =>
        db.artifactLinkTreePage.count({
          where: { organizationId, expiresAt: { lte: expired } },
        })
      )
    ).toBe(1001);
    expect(await sweepExpiredLinkTreePages()).toBe(1001);
    expect(
      await withDb((db) =>
        db.artifactLinkTreePage.count({ where: { organizationId } })
      )
    ).toBe(1);
  });

  it("legacy numeric clients reuse traversal and direction/depth/type stay scoped", async () => {
    const graph = await seed();
    const walk = vi.spyOn(artifactLinksService, "findLinkTree");
    expect(await allPages(graph, LinkDirection.Target, 2, true)).toEqual(
      graph.expected.slice(0, 2200)
    );
    expect(walk).toHaveBeenCalledTimes(1);
    expect(await allPages(graph, LinkDirection.Source)).toEqual([]);
    const page = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor(),
      LinkType.Blocks
    );
    expect(page).toEqual({ items: [] });
  });

  it("pins membership across inserts/deletes and rebuilds expired cursors at their offset", async () => {
    const graph = await seed();
    const first = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor()
    );
    const removed = graph.expected[1002];
    await withDb((db) =>
      db.artifactLink.deleteMany({
        where: { id: removed, organizationId: graph.organizationId },
      })
    );
    const added = await withDb((db) =>
      db.artifactLink.create({
        data: {
          organizationId: graph.organizationId,
          sourceId: graph.root,
          targetId: graph.levels[1][0],
          linkType: LinkType.RelatesTo,
        },
      })
    );
    const second = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor(1000, first.snapshotId)
    );
    expect(second.items.map((link) => link.id)).toEqual(
      graph.expected.slice(1000, 2000).filter((id) => id !== removed)
    );
    expect(second.nextCursor).toBe("2000");
    expect(second.items.some((link) => link.id === added.id)).toBe(false);
    expect((await allPages(graph)).includes(added.id)).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 86_400_001);
    const current = await artifactLinksService.findLinkTree(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5
    );
    const resumed = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor(2000, first.snapshotId)
    );
    expect(resumed.items.map((link) => link.id)).toEqual(
      current.slice(2000, 3000).map(({ link }) => link.id)
    );
    expect(resumed.snapshotId).not.toBe(first.snapshotId);
    expect(await sweepExpiredLinkTreePages()).toBeGreaterThan(0);
    expect(
      await withDb((db) =>
        db.artifactLinkTreePage.count({
          where: {
            organizationId: graph.organizationId,
            snapshotId: first.snapshotId,
          },
        })
      )
    ).toBe(0);
    expect(
      await withDb((db) =>
        db.artifactLinkTreePage.count({
          where: {
            organizationId: graph.organizationId,
            snapshotId: resumed.snapshotId,
          },
        })
      )
    ).toBe(2);
    const traversal = vi.spyOn(artifactLinksService, "findLinkTree");
    const final = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor(3000, resumed.snapshotId)
    );
    expect(final.items.map((link) => link.id)).toEqual(
      current.slice(3000).map(({ link }) => link.id)
    );
    expect(final.nextCursor).toBeUndefined();
    expect(traversal).not.toHaveBeenCalled();
  });

  it("does not reuse another tenant's snapshot even with its root and token", async () => {
    const graph = await seed();
    const first = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor()
    );
    const shallower = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      1,
      windowForCursor(1000, first.snapshotId)
    );
    expect(shallower.items.map((link) => link.id)).toEqual(
      graph.expected.slice(1000, 1100)
    );
    expect(shallower.nextCursor).toBeUndefined();
    const other = await createTestOrganization();
    organizations.push(other);
    expect(
      await artifactLinksService.findResolvedLinkTreePage(
        other,
        graph.root,
        LinkDirection.Both,
        5,
        windowForCursor(1000, first.snapshotId)
      )
    ).toEqual({ items: [] });
  });

  it("deduplicates cycles and shared nodes across the page boundary", async () => {
    const graph = await seedPagedTree(1001, 1);
    organizations.push(graph.organizationId);
    const [a, b, shared] = graph.levels[0];
    const extra = [
      { id: randomUUID(), sourceId: a, targetId: b },
      { id: randomUUID(), sourceId: b, targetId: a },
      { id: randomUUID(), sourceId: a, targetId: shared },
      { id: randomUUID(), sourceId: b, targetId: shared },
    ];
    await createLegacyProducesLinks(
      extra.map((link, index) => ({
        ...link,
        organizationId: graph.organizationId,
        linkType: LinkType.Produces,
        createdAt: new Date(1_800_000_000_000 + index),
      }))
    );
    // shared is discovered before b and a, so its incident edges emit first.
    expect(await allPages(graph)).toEqual([
      ...graph.expected,
      extra[3].id,
      extra[2].id,
      extra[1].id,
      extra[0].id,
    ]);
    expect(await allPages(graph, LinkDirection.Target, 1)).toEqual(
      graph.expected
    );
  });
});
