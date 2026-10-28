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

vi.mock("@/app/tags/tag-projection-select", () => ({
  mapTagRelations: vi.fn(() => []),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

import { LinkType } from "@repo/api/src/types/artifact";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { ArtifactType } from "@repo/database";
import { makeProducesLink as makeLink } from "@/__tests__/support/artifacts/project-tree.test-fixtures";
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
    documentDetail: { findMany: vi.fn().mockResolvedValue([]) },
    tagArtifact: { findMany: vi.fn() },
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
    mockDb.tagArtifact.findMany.mockResolvedValue([]);
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
 * ISS-5307's contract — two reads of one project name the same roots in the same
 * order, so a bounded slice cannot skip a row on one read and serve it twice on
 * the next — survives ISS-5732 even though the mechanism under it changed.
 *
 * ISS-5307 secured it by making a single-root ELECTION deterministic. There is
 * no election now: `A -> C <- B` yields BOTH A and B as roots, because each is an
 * artifact nothing parents. What has to stay order-independent is therefore the
 * root SET and the hierarchy beneath it, which is what these cases assert.
 */
describe("project tree — roots are order-independent (ISS-5307, ISS-5732)", () => {
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
      makeLink("link-a", rootA, childC, 1000),
      makeLink("link-b", rootB, childC, 2000),
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

  it("names the same roots and hierarchy whichever order the rows and links arrive in", async () => {
    const forward = await readTreeWith(tiedDiamond(), producesLinks());
    const reversed = await readTreeWith(
      [...tiedDiamond()].reverse(),
      [...producesLinks()].reverse()
    );

    // A and B are both parentless, so both are roots.
    expect(rootIds(forward.nodes)).toEqual([rootA, rootB]);
    expect(rootIds(reversed.nodes)).toEqual(rootIds(forward.nodes));
    // Arrival order must not move the shared child between the two roots.
    expect(parentageOf(reversed.nodes)).toEqual(parentageOf(forward.nodes));
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

/**
 * ISS-5732 — a `parentId` the tree emits must name a real direct PRODUCES edge.
 *
 * The multi-parent shape `A -> C <- B` is one weakly-connected component, and the
 * old projection collapsed it under a single elected root: every member the
 * root's DFS could not reach was emitted with a hardcoded `{depth: 1, parentId:
 * rootId}`. For `PRD-513 -> FEA-3730 <- PRD-602` that rendered PRD-602 and its
 * entire branch as children of PRD-513, a relationship no `artifact_link` row
 * asserts.
 *
 * The projection now assigns each child ONE canonical parent from its own
 * declared edges, so a root is simply an artifact no surviving edge parents.
 * `parentIdsAreRealEdges` is the invariant that makes that structural rather
 * than incidental; it fails on every fabricated row.
 */
describe("project tree — parentId always names a real PRODUCES edge (ISS-5732)", () => {
  const prdA = "aaaaaaaa-5732-7111-8111-111111111111";
  const prdB = "bbbbbbbb-5732-7111-8111-111111111111";
  const shared = "cccccccc-5732-7111-8111-111111111111";
  const onlyA = "dddddddd-5732-7111-8111-111111111111";
  const onlyB = "eeeeeeee-5732-7111-8111-111111111111";
  const grandchild = "ffffffff-5732-7111-8111-111111111111";

  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
  });

  /**
   * `PRD-513 -> FEA-3730 <- PRD-602` with a private descendant under each PRD and
   * a descendant under the shared child, so a collapsed component is visibly
   * wrong rather than merely differently-rooted.
   */
  function multiParentArtifacts() {
    return [
      makeArtifact(prdA, null),
      makeArtifact(prdB, null),
      makeArtifact(shared, null),
      makeArtifact(onlyA, null),
      makeArtifact(onlyB, null),
      makeArtifact(grandchild, null),
    ];
  }

  function multiParentLinks() {
    return [
      makeLink("link-1", prdA, shared, 1000),
      makeLink("link-2", prdA, onlyA, 2000),
      makeLink("link-3", prdB, onlyB, 3000),
      // Later than link-1, so `shared` stays under prdA — mirroring the live
      // rows, where PRD-513's edge predates PRD-602's.
      makeLink("link-4", prdB, shared, 4000),
      makeLink("link-5", shared, grandchild, 5000),
    ];
  }

  async function readTree(
    artifacts: ReturnType<typeof multiParentArtifacts>,
    links: ReturnType<typeof multiParentLinks>
  ) {
    mockDb.artifact.findMany.mockResolvedValue(artifacts);
    mockDb.artifactLink.findMany.mockResolvedValue(links);
    return await projectTreeService.getProjectTree(projectId, organizationId);
  }

  it("never nests one true root, or its branch, under another", async () => {
    const result = await readTree(multiParentArtifacts(), multiParentLinks());

    expect(rootIds(result.nodes).sort()).toEqual([prdA, prdB].sort());

    const underA = childIdsOf(result.nodes, prdA);
    expect(underA).not.toContain(prdB);
    expect(underA).not.toContain(onlyB);
    expect(childIdsOf(result.nodes, prdB)).toEqual([onlyB]);
  });

  it("emits no parentId that lacks a matching direct PRODUCES edge", async () => {
    const links = multiParentLinks();
    const result = await readTree(multiParentArtifacts(), links);

    expect(fabricatedEdges(result.nodes, links)).toEqual([]);
  });

  it("nests a shared child under the parent whose link came first", async () => {
    const result = await readTree(multiParentArtifacts(), multiParentLinks());

    // Mirrors the live rows behind the ticket: PRD-513's edge to FEA-3730
    // predates PRD-602's, so the shared child belongs to PRD-513.
    expect(parentageOf(result.nodes).get(shared)).toBe(prdA);
  });

  it("breaks an exact link-createdAt tie on the lower link id", async () => {
    const tied = multiParentLinks().map((link) =>
      link.targetId === shared
        ? { ...link, createdAt: new Date(SAME_INSTANT.getTime() + 9000) }
        : link
    );

    // Both candidate edges now share a millisecond, which this repo treats as
    // routine rather than exotic; `link-1` (prdA) sorts below `link-4` (prdB).
    const forward = await readTree(multiParentArtifacts(), tied);
    const reversed = await readTree(
      multiParentArtifacts(),
      [...tied].reverse()
    );

    expect(parentageOf(forward.nodes).get(shared)).toBe(prdA);
    expect(parentageOf(reversed.nodes).get(shared)).toBe(prdA);
  });

  it("bounds and reports truncation over roots that multi-parent lineage split", async () => {
    // The bound has only ever been exercised over UNLINKED roots. This is the
    // interaction ISS-5732 creates: a component that used to collapse to one
    // root now yields two, so a project that read complete can cross the bound.
    const artifacts = multiParentArtifacts();
    const links = multiParentLinks();
    mockDb.artifact.findMany.mockResolvedValue(artifacts);
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    const complete = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );
    expect(rootIds(complete.nodes)).toHaveLength(2);
    expect(Object.hasOwn(complete, "truncation")).toBe(false);

    const bounded = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 1 }
    );

    expect(bounded.truncation?.anchorsIncluded).toBe(1);
    expect(bounded.truncation?.anchorsMatchedAtLeast).toBe(2);
    expect(bounded.truncation?.reasons).toEqual([
      TreeTruncationReason.AnchorCap,
    ]);

    // The slice must be a stable prefix, or a repeated read serves one root
    // twice and drops the other.
    const repeated = await projectTreeService.getProjectTree(
      projectId,
      organizationId,
      { limit: 1 }
    );
    expect(rootIds(repeated.nodes)).toEqual(rootIds(bounded.nodes));
    expect(rootIds(bounded.nodes)[0]).toBe(rootIds(complete.nodes)[0]);
  });

  it("reports an out-of-project parent while an in-project edge still drives nesting", async () => {
    const externalParentId = "99999999-5732-7999-8999-999999999999";
    const externalParent = {
      ...makeArtifact(externalParentId, null),
      projectId: "88888888-8888-7888-8888-888888888888",
    };
    const links = [
      ...multiParentLinks(),
      makeLink("link-ext", externalParentId, shared, 6000),
    ];

    // Two DISTINCT answers: the project query, then the external-parent lookup.
    // A single `mockResolvedValue` would leave the parent unresolvable, so
    // `externalParents` would come back empty and any assertion over it would
    // pass without ever running.
    mockDb.artifact.findMany
      .mockResolvedValueOnce(multiParentArtifacts())
      .mockResolvedValueOnce([externalParent]);
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    const result = await projectTreeService.getProjectTree(
      projectId,
      organizationId
    );

    expect(result.externalParents).toHaveLength(1);
    expect(result.externalParents[0]?.childId).toBe(shared);
    expect(result.externalParents[0]?.parent.id).toBe(externalParentId);
    // The cross-project edge is surfaced, never nested: `shared` keeps the
    // in-project canonical parent, and the external parent is not a root.
    expect(parentageOf(result.nodes).get(shared)).toBe(prdA);
    expect(rootIds(result.nodes)).not.toContain(externalParentId);
  });

  it("keeps every artifact exactly once across all roots and children", async () => {
    const result = await readTree(multiParentArtifacts(), multiParentLinks());

    const emitted = result.nodes.flatMap((node) => [
      node.root.id,
      ...node.children.map((child) => child.id),
    ]);

    expect(emitted.slice().sort()).toEqual(
      multiParentArtifacts()
        .map((artifact) => artifact.id)
        .sort()
    );
  });
});

/**
 * ISS-5732 — `artifact_links` is user-writable, so it can hold a cycle, and the
 * projection must survive one without dropping rows or inventing lineage.
 *
 * The failure mode being guarded is specific: if a cycle goes UNDETECTED every
 * member acquires a canonical parent, so no member qualifies as a root, and
 * because children are only ever reached by walking DOWN from a root the entire
 * component disappears from the response. Silently missing rows are worse than
 * the misattributed ones ISS-5732 set out to fix, which is why the guard is
 * exact rather than depth-capped.
 */
describe("project tree — cyclic PRODUCES links (ISS-5732)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
  });

  function cycleId(index: number): string {
    return `${String(index).padStart(8, "0")}-c1c1-7111-8111-111111111111`;
  }

  async function readTree(
    artifacts: { id: string }[],
    links: ReturnType<typeof makeLink>[]
  ) {
    mockDb.artifact.findMany.mockResolvedValue(artifacts);
    mockDb.artifactLink.findMany.mockResolvedValue(links);
    return await projectTreeService.getProjectTree(projectId, organizationId);
  }

  it("keeps a two-cycle and its tail whole, naming the same root either way", async () => {
    const a = cycleId(1);
    const b = cycleId(2);
    const c = cycleId(3);
    const artifacts = [
      makeArtifact(a, null),
      makeArtifact(b, null),
      makeArtifact(c, null),
    ];
    const links = [
      makeLink("cyc-1", a, b, 1000),
      makeLink("cyc-2", b, a, 2000),
      makeLink("cyc-3", b, c, 3000),
    ];

    const forward = await readTree(artifacts, links);
    const reversed = await readTree(
      [...artifacts].reverse(),
      [...links].reverse()
    );

    // `a -> b` is adopted first, so `b -> a` would close the cycle and is
    // rejected, leaving `a` the only unparented member. Asserting WHICH member
    // roots the component is the point: merely counting roots would pass even if
    // arrival order decided the answer.
    expect(rootIds(forward.nodes)).toEqual([a]);
    expect(rootIds(reversed.nodes)).toEqual([a]);
    expect(parentageOf(reversed.nodes)).toEqual(parentageOf(forward.nodes));
    expect(fabricatedEdges(forward.nodes, links)).toEqual([]);
  });

  it("does not lose a cycle longer than the assignee tree's depth cap", async () => {
    // 25 members: longer than MAX_CHAIN_DEPTH (20), the bound the assignee-scoped
    // tree's own guard stops at. A capped guard would miss the closing edge here,
    // parent every member, and drop all 25 rows.
    const size = 25;
    const ids = Array.from({ length: size }, (_unused, i) => cycleId(i + 10));
    const artifacts = ids.map((id) => makeArtifact(id, null));
    const links = ids.map((id, index) =>
      makeLink(`ring-${index}`, id, ids[(index + 1) % size]!, 1000 + index)
    );

    const result = await readTree(artifacts, links);

    const emitted = result.nodes.flatMap((node) => [
      node.root.id,
      ...node.children.map((child) => child.id),
    ]);
    expect(emitted.slice().sort()).toEqual([...ids].sort());
    expect(result.nodes).toHaveLength(1);
    expect(fabricatedEdges(result.nodes, links)).toEqual([]);
  });

  it("leaves a self-linked artifact as its own root", async () => {
    const a = cycleId(90);
    const result = await readTree(
      [makeArtifact(a, null)],
      [makeLink("self-1", a, a, 1000)]
    );

    expect(rootIds(result.nodes)).toEqual([a]);
    expect(result.nodes[0]?.children).toEqual([]);
  });
});

/** Flat `childId -> parentId` view of a whole response, for order comparisons. */
function parentageOf(
  nodes: { children: { id: string; parentId: string }[] }[]
): Map<string, string> {
  const parentage = new Map<string, string>();
  for (const node of nodes) {
    for (const child of node.children) {
      parentage.set(child.id, child.parentId);
    }
  }
  return parentage;
}

/** Ids directly beneath `rootId`'s node, at any depth. */
function childIdsOf(
  nodes: { root: { id: string }; children: { id: string }[] }[],
  rootId: string
): string[] {
  const node = nodes.find((candidate) => candidate.root.id === rootId);
  return node ? node.children.map((child) => child.id) : [];
}

/**
 * Every emitted `(parentId -> child)` pair that no PRODUCES link declares.
 * Returns the offending pairs rather than a boolean so a failure names them.
 */
function fabricatedEdges(
  nodes: {
    root: { id: string };
    children: { id: string; parentId: string }[];
  }[],
  links: { sourceId: string; targetId: string }[]
): string[] {
  const declared = new Set(
    links.map((link) => `${link.sourceId}->${link.targetId}`)
  );
  const fabricated: string[] = [];
  for (const node of nodes) {
    for (const child of node.children) {
      const edge = `${child.parentId}->${child.id}`;
      if (!declared.has(edge)) {
        fabricated.push(edge);
      }
    }
  }
  return fabricated;
}
