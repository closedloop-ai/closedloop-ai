/**
 * ISS-5307 — the project tree's optional `limit` bound, and the total ordering
 * that makes bounding it safe.
 *
 * Two properties are under test, and they only hold together:
 *  - a bounded read returns a PREFIX of the root ordering plus an explicit
 *    truncation, and an unbounded read is byte-for-byte what it always was;
 *  - that ordering is TOTAL, so the same prefix comes back every time. Without
 *    a unique tiebreaker, two roots tied on rank AND timestamp could swap
 *    places between reads, and the bound would then drop one root on one read
 *    and the other root on the next — a row skipped or served twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/documents/generation-status-helpers", () => ({
  mergeLoopStatuses: vi.fn(),
  suppressDismissedFailuresForDocumentMap: vi.fn(),
}));

vi.mock("@/app/tags/service", () => ({
  mapTagRelations: vi.fn(() => []),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { LinkType } from "@repo/api/src/types/artifact";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { ArtifactType } from "@repo/database";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { compareByStackRank } from "./artifact-tree-shared";
import { projectTreeService } from "./project-tree-service";

const projectId = "11111111-1111-7111-8111-111111111111";
const organizationId = "33333333-3333-7333-8333-333333333333";
const SAME_INSTANT = new Date("2026-08-05T12:00:00.000Z");

function createMockDb() {
  return {
    $queryRaw: vi.fn(),
    artifact: { findMany: vi.fn() },
    artifactLink: { findMany: vi.fn() },
  };
}

function makeArtifact(id: string, sortOrder: number | null) {
  return {
    assignee: null,
    createdAt: SAME_INSTANT,
    id,
    name: id,
    organizationId,
    projectId,
    sortOrder,
    type: ArtifactType.DOCUMENT,
  };
}

/** Ten unlinked roots, each its own component, ranked 0..9. */
function tenRoots() {
  return Array.from({ length: 10 }, (_unused, i) =>
    makeArtifact(`root-${String(i).padStart(2, "0")}`, i)
  );
}

function rootIds(nodes: { root: { id: string } }[]): string[] {
  return nodes.map((node) => node.root.id);
}

describe("project tree — bounded root read (ISS-5307)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockDb.artifact.findMany.mockResolvedValue(tenRoots());
    mockDb.artifactLink.findMany.mockResolvedValue([]);
  });

  it("returns every root and NO truncation field when no limit is given", async () => {
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.nodes).toHaveLength(10);
    // Absence is the contract's claim of completeness — the key must not be
    // present at all, not present-and-undefined.
    expect(Object.hasOwn(result, "truncation")).toBe(false);
  });

  it("bounds the response to the requested number of roots", async () => {
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 4 }
    );

    expect(result.nodes).toHaveLength(4);
    expect(rootIds(result.nodes)).toEqual([
      "root-00",
      "root-01",
      "root-02",
      "root-03",
    ]);
  });

  it("states how much it served and how much matched when the bound bites", async () => {
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 4 }
    );

    expect(result.truncation).toEqual({
      anchorsIncluded: 4,
      anchorsMatchedAtLeast: 10,
      reasons: [TreeTruncationReason.AnchorCap],
    });
  });

  it("does not claim truncation when the project fits inside the bound", async () => {
    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 50 }
    );

    expect(result.nodes).toHaveLength(10);
    expect(Object.hasOwn(result, "truncation")).toBe(false);
  });

  it("serves consecutive, non-overlapping prefixes as the bound widens", async () => {
    const four = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 4 }
    );
    const eight = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 8 }
    );

    // A wider bound must EXTEND the narrower one, never reshuffle it — that is
    // what makes paging over this ordering safe.
    expect(rootIds(eight.nodes).slice(0, 4)).toEqual(rootIds(four.nodes));
  });

  it("drops external-parent entries whose child was bounded away", async () => {
    const externalParentId = "99999999-9999-7999-8999-999999999999";
    mockDb.artifact.findMany.mockResolvedValue(tenRoots());
    mockDb.artifactLink.findMany.mockResolvedValue([
      // Parent lives outside the project; child `root-09` is past a limit of 4.
      {
        linkType: LinkType.Produces,
        sourceId: externalParentId,
        targetId: "root-09",
      },
    ]);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 4 }
    );

    // The contract promises every `childId` is present in `nodes`; an entry
    // pointing at a bounded-away row would break that promise.
    const returnedRootIds = new Set(rootIds(result.nodes));
    for (const entry of result.externalParents) {
      expect(returnedRootIds.has(entry.childId)).toBe(true);
    }
  });

  it("bounds the detailed (`?include=details`) tree the same way", async () => {
    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId,
      { limit: 3 }
    );

    expect(result.nodes).toHaveLength(3);
    expect(result.truncation?.anchorsIncluded).toBe(3);
    expect(result.truncation?.anchorsMatchedAtLeast).toBe(10);
  });

  it("omits truncation from the detailed tree on a complete read", async () => {
    const result = await projectTreeService.getProjectTreeWithDetails(
      projectId,
      organizationId
    );

    expect(Object.hasOwn(result, "truncation")).toBe(false);
  });
});

/**
 * ISS-5307 (wongk): `compareByStackRank` orders roots that have already been
 * CHOSEN, so it cannot stabilise a component whose representative was picked
 * nondeterministically. `A -> C <- B` with A and B sharing a `createdAt` is the
 * shape that exposes it: both are parentless candidates, and before the id
 * tie-break the winner was whichever the link/BFS iteration listed first. Two
 * reads could then name different roots for the same component and move a
 * different row across the bounded-read boundary.
 */
describe("project tree — component root is order-independent (ISS-5307)", () => {
  const rootA = "aaaaaaaa-1111-7111-8111-111111111111";
  const rootB = "bbbbbbbb-1111-7111-8111-111111111111";
  const childC = "cccccccc-1111-7111-8111-111111111111";

  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
  });

  /** A and B are both parentless and created in the same millisecond. */
  function tiedDiamond() {
    return [
      makeArtifact(rootA, null),
      makeArtifact(rootB, null),
      makeArtifact(childC, null),
    ];
  }

  function producesLinks() {
    return [
      { linkType: LinkType.Produces, sourceId: rootA, targetId: childC },
      { linkType: LinkType.Produces, sourceId: rootB, targetId: childC },
    ];
  }

  async function readTreeWith(
    artifacts: ReturnType<typeof tiedDiamond>,
    links: ReturnType<typeof producesLinks>
  ) {
    mockDb.artifact.findMany.mockResolvedValue(artifacts);
    mockDb.artifactLink.findMany.mockResolvedValue(links);
    return await projectTreeService.getProjectTree(projectId, organizationId);
  }

  it("names the same root whichever order the rows and links arrive in", async () => {
    const forward = await readTreeWith(tiedDiamond(), producesLinks());
    const reversed = await readTreeWith(
      [...tiedDiamond()].reverse(),
      [...producesLinks()].reverse()
    );

    // Link insertion order drives the BFS seed order, so reversing it is what
    // flipped the chosen root before the tie-break existed.
    expect(rootIds(forward.nodes)).toEqual([rootA]);
    expect(rootIds(reversed.nodes)).toEqual(rootIds(forward.nodes));
  });

  it("still prefers the earlier-created candidate over the lower id", async () => {
    const earlier = new Date(SAME_INSTANT.getTime() - 1000);
    const artifacts = tiedDiamond();
    // `rootB` sorts after `rootA`, so an id-only rule would pick the wrong one.
    artifacts[1] = { ...artifacts[1], createdAt: earlier };

    const result = await readTreeWith(artifacts, producesLinks());

    expect(rootIds(result.nodes)).toEqual([rootB]);
  });
});

describe("compareByStackRank — total order (ISS-5307 / FEA-4329)", () => {
  function node(id: string, sortOrder: number | null, createdAt: Date) {
    return { children: [], root: { createdAt, id, sortOrder } };
  }

  it("breaks a rank+timestamp tie on the unique id instead of returning 0", () => {
    const a = node("aaaa", 5, SAME_INSTANT);
    const b = node("bbbb", 5, SAME_INSTANT);

    // A 0 here would leave the pair in driver order, which differs per read —
    // and a bounded slice over an unstable order skips or duplicates rows.
    expect(compareByStackRank(a as never, b as never)).toBeLessThan(0);
    expect(compareByStackRank(b as never, a as never)).toBeGreaterThan(0);
  });

  it("sorts a tied group identically regardless of input order", () => {
    const ids = ["ddd", "aaa", "ccc", "bbb"];
    const forward = ids.map((id) => node(id, 5, SAME_INSTANT));
    const reversed = [...ids].reverse().map((id) => node(id, 5, SAME_INSTANT));

    const sortIds = (nodes: ReturnType<typeof node>[]) =>
      [...nodes].sort(compareByStackRank as never).map((n) => n.root.id);

    expect(sortIds(forward)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
    expect(sortIds(forward)).toEqual(sortIds(reversed));
  });

  it("still puts rank before timestamp and timestamp before id", () => {
    const older = new Date("2026-08-01T00:00:00.000Z");
    const lowRank = node("zzz", 1, older);
    const highRank = node("aaa", 2, SAME_INSTANT);
    expect(
      compareByStackRank(lowRank as never, highRank as never)
    ).toBeLessThan(0);

    // Same rank: newer first (createdAt DESC), whatever the ids say.
    const newer = node("zzz", 3, SAME_INSTANT);
    const stale = node("aaa", 3, older);
    expect(compareByStackRank(newer as never, stale as never)).toBeLessThan(0);
  });

  it("keeps null-ranked roots last", () => {
    const ranked = node("zzz", 0, SAME_INSTANT);
    const unranked = node("aaa", null, SAME_INSTANT);

    expect(compareByStackRank(ranked as never, unranked as never)).toBeLessThan(
      0
    );
  });
});
