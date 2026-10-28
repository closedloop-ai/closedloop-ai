import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./branch-list-enrichment", async () => {
  const actual = await vi.importActual<
    typeof import("./branch-list-enrichment")
  >("./branch-list-enrichment");
  return {
    ...actual,
    reportBranchListEnrichmentFailedOpen: vi.fn(),
  };
});

import {
  BranchListEnrichmentRead,
  reportBranchListEnrichmentFailedOpen,
} from "./branch-list-enrichment";
import {
  BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE,
  BRANCH_PUSH_LOC_ATOM_READ_MAX,
  loadBranchPushLocAtoms,
  loadBranchPushLocAtomsFailingOpen,
  withBranchPushLocEvidence,
} from "./branch-push-loc-read";

beforeEach(() => {
  vi.mocked(reportBranchListEnrichmentFailedOpen).mockClear();
});

const ORGANIZATION_ID = "org-1";
const BEFORE_SHA = "b".repeat(40);
const AFTER_SHA = "c".repeat(40);

function atomRow(overrides: Record<string, unknown> = {}) {
  return {
    branchArtifactId: "branch-1",
    sourceEventId: "delivery-1",
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    beforeSha: BEFORE_SHA,
    afterSha: AFTER_SHA,
    linesAdded: 4,
    linesRemoved: 1,
    ...overrides,
  };
}

function clientReturning(rows: readonly ReturnType<typeof atomRow>[]) {
  const findMany = vi.fn().mockResolvedValue([...rows]);
  return {
    findMany,
    db: { branchActivityAtom: { findMany } } as unknown as Parameters<
      typeof loadBranchPushLocAtoms
    >[0],
  };
}

describe("loadBranchPushLocAtoms", () => {
  // The query is newest-first (so the cap sheds the OLDEST pushes), but callers
  // want occurrence order — so the rows arrive descending here and must come
  // back ascending.
  it("groups a branch's captured pushes in occurrence order", async () => {
    const { db } = clientReturning([
      atomRow({
        sourceEventId: "second",
        occurredAt: new Date("2026-08-02T00:00:00.000Z"),
      }),
      atomRow({ sourceEventId: "first" }),
      atomRow({ branchArtifactId: "branch-2", sourceEventId: "other" }),
    ]);

    const evidence = await loadBranchPushLocAtoms(db, ORGANIZATION_ID, [
      "branch-1",
      "branch-2",
    ]);

    expect(
      evidence.byBranchId.get("branch-1")?.map((atom) => atom.sourceEventId)
    ).toEqual(["first", "second"]);
    expect(
      evidence.byBranchId.get("branch-2")?.map((atom) => atom.sourceEventId)
    ).toEqual(["other"]);
    expect(evidence.truncatedBranchIds.size).toBe(0);
  });

  // The cap must shed the pushes captured EARLIEST. Dropping the latest would
  // shed the atom whose `afterSha` names a merged PR's head, and the projection
  // would then keep that PR's whole diff AND the surviving earlier push deltas
  // — double-counting, while the truncation gap claims a short total.
  //
  // Ordered on `createdAt`, the server write clock, NOT the client-controlled
  // `occurredAt`: a rebase that back-dates the final push would otherwise sort
  // it below the cut and reintroduce exactly that inflation.
  it("orders the cap on the server write clock, not the client commit date", async () => {
    const { db, findMany } = clientReturning([]);

    await loadBranchPushLocAtoms(db, ORGANIZATION_ID, ["branch-1"]);

    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { createdAt: "desc" },
      { sourceEventId: "desc" },
    ]);
  });

  // The ordering above only helps if the SLICE keeps the head of the result.
  // This pins WHICH atoms survive, not just how many: reverse the slice and the
  // newest-captured push — the one covering a merged PR head — disappears.
  it("keeps the newest-captured pushes and discloses when a chunk fills the budget", async () => {
    const rows = Array.from(
      { length: BRANCH_PUSH_LOC_ATOM_READ_MAX + 1 },
      (_, index) =>
        atomRow({
          sourceEventId: `delivery-${index}`,
          // Descending, exactly as the server returns them.
          createdAt: new Date(Date.UTC(2026, 7, 1) - index * 1000),
          occurredAt: new Date(Date.UTC(2026, 7, 1) - index * 1000),
        })
    );
    const { db, findMany } = clientReturning([]);
    findMany.mockImplementation(({ take }) =>
      Promise.resolve(rows.slice(0, take))
    );

    const evidence = await loadBranchPushLocAtoms(db, ORGANIZATION_ID, [
      "branch-1",
    ]);
    const kept = evidence.byBranchId.get("branch-1") ?? [];
    const keptIds = new Set(kept.map((atom) => atom.sourceEventId));

    expect(kept).toHaveLength(BRANCH_PUSH_LOC_ATOM_READ_MAX);
    // The newest-captured survived…
    expect(keptIds.has("delivery-0")).toBe(true);
    // …and the single oldest-captured is the one that was shed.
    expect(keptIds.has(`delivery-${BRANCH_PUSH_LOC_ATOM_READ_MAX}`)).toBe(
      false
    );
    expect(evidence.truncatedBranchIds).toEqual(new Set(["branch-1"]));
  });

  // A sha-less atom cannot be placed on a range, so it contributes no lines —
  // but it is CARRIED as unusable rather than discarded, so the projection can
  // disclose it. Silently dropping it would let a branch read Complete while
  // that push's lines are missing.
  it("carries an atom with no sha range as unusable rather than discarding it", async () => {
    const { db } = clientReturning([
      atomRow({ sourceEventId: "no-range", beforeSha: null }),
      atomRow({ sourceEventId: "ranged" }),
    ]);

    const evidence = await loadBranchPushLocAtoms(db, ORGANIZATION_ID, [
      "branch-1",
    ]);

    expect(
      evidence.byBranchId.get("branch-1")?.map((atom) => atom.sourceEventId)
    ).toEqual(["ranged"]);
    expect(
      evidence.unusableByBranchId
        .get("branch-1")
        ?.map((atom) => atom.sourceEventId)
    ).toEqual(["no-range"]);
  });

  // Even an exact fill cannot prove completeness without a lookahead row.
  // The literal transport ceiling takes priority; unread chunks disclose too.
  it("discloses the budget-filling chunk and unread chunks without probing beyond the cap", async () => {
    const overflowing = Array.from(
      { length: BRANCH_PUSH_LOC_ATOM_READ_MAX },
      (_, index) => atomRow({ sourceEventId: `delivery-${index}` })
    );
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(overflowing)
      .mockResolvedValueOnce([atomRow({ branchArtifactId: "branch-late" })]);
    const db = {
      branchActivityAtom: { findMany },
    } as unknown as Parameters<typeof loadBranchPushLocAtoms>[0];
    const branchIds = [
      ...Array.from(
        { length: BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE },
        (_, index) => (index === 0 ? "branch-1" : `branch-pad-${index}`)
      ),
      "branch-late",
    ];

    const evidence = await loadBranchPushLocAtoms(
      db,
      ORGANIZATION_ID,
      branchIds
    );

    expect(evidence.truncatedBranchIds.has("branch-1")).toBe(true);
    expect(evidence.truncatedBranchIds.has("branch-late")).toBe(true);
    expect(evidence.truncatedBranchIds.size).toBe(
      BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE + 1
    );
    expect(evidence.byBranchId.get("branch-1")).toHaveLength(
      BRANCH_PUSH_LOC_ATOM_READ_MAX
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(20_000);
  });

  it("caps total transport at 20000 rows across a multi-chunk cohort", async () => {
    const branchIds = Array.from(
      { length: BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE * 3 },
      (_, index) => `branch-${index}`
    );
    let transported = 0;
    const findMany = vi.fn().mockImplementation(({ where, take }) => {
      const branchArtifactId = where.branchArtifactId.in[0];
      const available = branchArtifactId === "branch-0" ? 12_000 : 9000;
      const rows = Array.from(
        { length: Math.min(available, take) },
        (_, index) =>
          atomRow({
            branchArtifactId,
            sourceEventId: `${branchArtifactId}-${index}`,
          })
      );
      transported += rows.length;
      return Promise.resolve(rows);
    });
    const db = { branchActivityAtom: { findMany } } as unknown as Parameters<
      typeof loadBranchPushLocAtoms
    >[0];

    const evidence = await loadBranchPushLocAtoms(
      db,
      ORGANIZATION_ID,
      branchIds
    );

    expect(transported).toBe(20_000);
    expect(findMany.mock.calls.map(([query]) => query.take)).toEqual([
      20_000, 8000,
    ]);
    expect(evidence.byBranchId.get("branch-0")).toHaveLength(12_000);
    expect(
      evidence.byBranchId.get(`branch-${BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE}`)
    ).toHaveLength(8000);
    expect(evidence.truncatedBranchIds).toEqual(
      new Set(branchIds.slice(BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE))
    );
    expect(
      evidence.byBranchId.has(
        `branch-${BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE * 3 - 1}`
      )
    ).toBe(false);
  });

  it("chunks the id predicate so a large cohort cannot exhaust the bind limit", async () => {
    const { db, findMany } = clientReturning([]);
    const branchIds = Array.from(
      { length: BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE + 1 },
      (_, index) => `branch-${index}`
    );

    await loadBranchPushLocAtoms(db, ORGANIZATION_ID, branchIds);

    expect(findMany).toHaveBeenCalledTimes(2);
    const chunkSizes = findMany.mock.calls.map((call) => {
      const ids = call[0]?.where?.branchArtifactId?.in;
      return Array.isArray(ids) ? ids.length : null;
    });
    expect(chunkSizes).toEqual([BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE, 1]);
  });

  it("issues no query for an empty cohort", async () => {
    const { db, findMany } = clientReturning([]);

    const evidence = await loadBranchPushLocAtoms(db, ORGANIZATION_ID, []);

    expect(findMany).not.toHaveBeenCalled();
    expect(evidence.byBranchId.size).toBe(0);
  });
});

describe("withBranchPushLocEvidence", () => {
  it("attaches each row its own atoms and its own truncation verdict", () => {
    const rows = [
      { id: "branch-1", branch: { branchName: "feat/a" } },
      { id: "branch-2", branch: { branchName: "feat/b" } },
    ];
    const atoms = [
      {
        branchArtifactId: "branch-1",
        sourceEventId: "delivery-1",
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        linesAdded: 4,
        linesRemoved: 1,
      },
    ];

    const attached = withBranchPushLocEvidence(rows, {
      byBranchId: new Map([["branch-1", atoms]]),
      unusableByBranchId: new Map(),
      truncatedBranchIds: new Set(["branch-1"]),
    });

    expect(attached[0]?.branch).toEqual({
      branchName: "feat/a",
      pushLocAtoms: atoms,
      unusablePushLocAtoms: [],
      pushLocEvidenceTruncated: true,
    });
    // The sibling that makes the flag per-branch rather than per-cohort.
    expect(attached[1]?.branch).toEqual({
      branchName: "feat/b",
      pushLocAtoms: [],
      unusablePushLocAtoms: [],
      pushLocEvidenceTruncated: false,
    });
  });
});

describe("loadBranchPushLocAtomsFailingOpen", () => {
  // This read enriches the LOC cards, so it must not reject a response whose
  // rows already computed. Degrading has to REPORT, though: empty evidence is
  // indistinguishable downstream from a cohort that has genuinely captured
  // nothing, so a permanent defect would render as an ordinary "no pushes yet"
  // forever with nothing for a monitor to fire on.
  it("degrades to empty evidence and reports the failure", async () => {
    const failure = new Error("connection terminated");
    const findMany = vi.fn().mockRejectedValue(failure);
    const db = { branchActivityAtom: { findMany } } as unknown as Parameters<
      typeof loadBranchPushLocAtoms
    >[0];

    const evidence = await loadBranchPushLocAtomsFailingOpen(
      db,
      ORGANIZATION_ID,
      ["branch-1"]
    );

    expect(evidence.byBranchId.size).toBe(0);
    expect(reportBranchListEnrichmentFailedOpen).toHaveBeenCalledWith(
      BranchListEnrichmentRead.PushLoc,
      failure,
      { organizationId: ORGANIZATION_ID, rowCount: 1 }
    );
  });

  // The sibling that keeps the assertion above from passing on any read: a
  // successful one reports nothing.
  it("reports nothing when the read succeeds", async () => {
    const { db } = clientReturning([atomRow()]);

    const evidence = await loadBranchPushLocAtomsFailingOpen(
      db,
      ORGANIZATION_ID,
      ["branch-1"]
    );

    expect(evidence.byBranchId.get("branch-1")).toHaveLength(1);
    expect(reportBranchListEnrichmentFailedOpen).not.toHaveBeenCalled();
  });
});
