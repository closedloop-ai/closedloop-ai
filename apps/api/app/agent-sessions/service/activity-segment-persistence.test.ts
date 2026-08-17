import type {
  SyncedActivitySegmentRow,
  SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistSessionActivitySegments } from "./activity-segment-persistence";
import type { AgentSessionUpsertTx } from "./records";

// FEA-3568 T3: persistSessionActivitySegments is exercised against a mock
// transaction client, so these cover the replace-all / no-op / sanity-reject /
// version-guard branches without a real database (the T2 migration is
// unapplied). Round-trip DB integration is covered separately once the
// migration is applied.
const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@repo/observability/log", () => ({ log: mockLog }));

const ARTIFACT_ID = "session-artifact-1";
const ORGANIZATION_ID = "org-1";

function makeTx(storedVersion: number | null = null) {
  const findFirst = vi
    .fn()
    .mockResolvedValue(
      storedVersion === null ? null : { classifierVersion: storedVersion }
    );
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const tx = {
    agentSessionActivitySegment: { findFirst, deleteMany, createMany },
  } as unknown as AgentSessionUpsertTx;
  return { tx, findFirst, deleteMany, createMany };
}

function row(
  overrides: Partial<SyncedActivitySegmentRow> = {}
): SyncedActivitySegmentRow {
  return {
    phase: "implement",
    startMs: 0,
    endMs: 1000,
    confidence: 0.8,
    evidenceLayers: ["structural"],
    version: 4,
    workItemRef: null,
    subagentId: null,
    ...overrides,
  };
}

function sessionWith(
  rows: SyncedActivitySegmentRow[] | null | undefined
): SyncedAgentSession {
  return { activitySegmentRows: rows } as unknown as SyncedAgentSession;
}

// ISS-4541: a multi-part (chunked) session carrying a `{ index, total }` marker.
function chunkedSessionWith(
  rows: SyncedActivitySegmentRow[] | null | undefined,
  chunk: { index: number; total: number }
): SyncedAgentSession {
  return { activitySegmentRows: rows, chunk } as unknown as SyncedAgentSession;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("persistSessionActivitySegments (FEA-3568 T3)", () => {
  it("no-ops when the field is absent (older desktop build)", async () => {
    const { tx, findFirst, deleteMany, createMany } = makeTx();
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith(undefined)
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("no-ops when the field is null", async () => {
    const { tx, deleteMany, createMany } = makeTx();
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith(null)
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("replace-alls the tiling on first sync (no stored version), mapping fields incl. BigInt bounds", async () => {
    const { tx, deleteMany, createMany } = makeTx(null);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith([
        row({ phase: "plan", startMs: 0, endMs: 500, version: 4 }),
        row({
          phase: "implement",
          startMs: 500,
          endMs: 1500,
          version: 4,
          workItemRef: "FEA-3568",
          evidenceLayers: ["declared", "structural"],
        }),
      ])
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        agentSessionId: ARTIFACT_ID,
        session: { artifact: { organizationId: ORGANIZATION_ID } },
      },
    });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          agentSessionId: ARTIFACT_ID,
          phase: "plan",
          startMs: 0n,
          endMs: 500n,
          confidence: 0.8,
          evidenceLayers: ["structural"],
          classifierVersion: 4,
          workItemRef: null,
          subagentId: null,
        },
        {
          agentSessionId: ARTIFACT_ID,
          phase: "implement",
          startMs: 500n,
          endMs: 1500n,
          confidence: 0.8,
          evidenceLayers: ["declared", "structural"],
          classifierVersion: 4,
          workItemRef: "FEA-3568",
          subagentId: null,
        },
      ],
    });
  });

  it("replaces when the incoming classifier version is newer than stored", async () => {
    const { tx, deleteMany, createMany } = makeTx(3);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith([row({ version: 4 })])
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("skips a stale replace when the incoming version is older than stored (no delete/create)", async () => {
    const { tx, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith([row({ version: 4 })])
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("rejects (logs + skips) an overlapping tiling without touching the DB", async () => {
    const { tx, findFirst, deleteMany, createMany } = makeTx();
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith([
        row({ startMs: 0, endMs: 1000 }),
        row({ startMs: 500, endMs: 1500 }), // overlaps the previous span
      ])
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("no-ops on an explicit empty array (never wipes the stored tiling)", async () => {
    // An empty payload carries no classifier version to attest, so honoring it as
    // a clear could only downgrade a newer persisted tiling out-of-order. The
    // desktop signals "no segments" by omitting the field, never by sending `[]`,
    // so treating empty as a no-op loses nothing and closes the stale-wipe hole.
    const { tx, findFirst, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith([])
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("persistSessionActivitySegments — ISS-4541 multi-part tiling", () => {
  it("opening chunk (shouldReplace) replace-alls, appending later chunks merges idempotently", async () => {
    // A tiling paginated across two parts: chunk 0 (opening) replace-deletes the
    // stored tiling and inserts its slice; chunk 1 appends its disjoint slice
    // with skipDuplicates. The FULL tiling (all 4 rows) reaches the DB across the
    // two parts — never truncated to one payload. The stored version is 4 (what
    // chunk 0 established), so the version-matched append slice (also version 4)
    // is admitted (ISS-4578 append-lane classifier-version guard).
    const { tx, deleteMany, createMany } = makeTx(4);
    const sliceA = [
      row({ startMs: 0, endMs: 1000 }),
      row({ startMs: 1000, endMs: 2000 }),
    ];
    const sliceB = [
      row({ startMs: 2000, endMs: 3000 }),
      row({ startMs: 3000, endMs: 4000 }),
    ];

    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith(sliceA, { index: 0, total: 2 }),
      /* shouldReplace */ true
    );
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith(sliceB, { index: 1, total: 2 }),
      /* shouldReplace */ false
    );

    // Chunk 0 replace-deletes once; chunk 1 does NOT delete (append-only).
    expect(deleteMany).toHaveBeenCalledTimes(1);
    // Both parts insert their slice; the append is skipDuplicates-idempotent.
    expect(createMany).toHaveBeenCalledTimes(2);
    const appendCall = createMany.mock.calls[1]?.[0];
    expect(appendCall.skipDuplicates).toBe(true);
    // Full fidelity: every startMs across both parts reaches the DB, none dropped.
    const insertedStarts = createMany.mock.calls
      .flatMap((call) => call[0].data as Array<{ startMs: bigint }>)
      .map((r) => Number(r.startMs))
      .sort((a, b) => a - b);
    expect(insertedStarts).toEqual([0, 1000, 2000, 3000]);
  });

  it("re-sending an append chunk stays idempotent (skipDuplicates, no delete)", async () => {
    // Stored version 4 matches the append slice's version 4, so both appends are
    // admitted; skipDuplicates makes the retry a no-op at the DB.
    const { tx, deleteMany, createMany } = makeTx(4);
    const sliceB = [row({ startMs: 2000, endMs: 3000 })];
    // Simulate a retry of a later chunk: it must never delete, always skipDuplicates.
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith(sliceB, { index: 1, total: 2 }),
      /* shouldReplace */ false
    );
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith(sliceB, { index: 1, total: 2 }),
      /* shouldReplace */ false
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledTimes(2);
    for (const call of createMany.mock.calls) {
      expect(call[0].skipDuplicates).toBe(true);
    }
  });

  it("an append slice whose classifier version does NOT match the stored tiling is skipped (codex P1: no mixed-version tiling)", async () => {
    // codex pM6VI3Of: when chunk 0 established a stored tiling at version 5, a
    // later slice carrying an OLDER version 4 (a superseded re-delivery of a
    // rejected tiling's slices 1..N) must NOT append — that would leave the newer
    // tiling PLUS stale slices, mixed versions with overlapping spans that
    // double-count in the per-phase aggregation. The append lane version-guards it.
    const { tx, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith([row({ startMs: 2000, endMs: 3000, version: 4 })], {
        index: 1,
        total: 2,
      }),
      /* shouldReplace */ false
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("an append slice arriving before any chunk 0 is staged (no stored tiling) is skipped, not blindly inserted", async () => {
    // A later chunk that reaches the receiver before its own chunk 0 opened the
    // sequence has no stored tiling to attest against; appending it would seed a
    // headless partial tiling. Skip it — the sequence self-repairs when chunk 0
    // lands.
    const { tx, deleteMany, createMany } = makeTx(null);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith([row({ startMs: 2000, endMs: 3000, version: 4 })], {
        index: 1,
        total: 2,
      }),
      /* shouldReplace */ false
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("an opening chunk with an EMPTY slice still clears the prior revision's tiling (multi-part)", async () => {
    // ISS-4541: when the tiling paginates into its own later chunks, chunk 0 may
    // carry an empty slice — it MUST still delete the stored tiling so a prior
    // revision's segments don't survive under the newer sequence. (Contrast the
    // unchunked empty-array no-op below.)
    const { tx, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith([], { index: 0, total: 3 }),
      /* shouldReplace */ true
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("a multi-part opening chunk that OMITS the tiling field never wipes the stored tiling (codex P1)", async () => {
    // ISS-4578 (codex P1): an events-only chunk 0 of a multi-part sequence
    // carries NO `activitySegmentRows` key (the base rides `...session`, and a
    // segment-less base omits the field). Collapsing ABSENT -> `[]` and then
    // running the multi-part opening delete would wipe the session's complete
    // stored tiling. An absent field must always leave the stored tiling
    // untouched, even on a multi-part opening chunk (total > 1, shouldReplace).
    const { tx, findFirst, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      // Field ABSENT (undefined), NOT an explicit []: an events/tokenEvents chunk.
      chunkedSessionWith(undefined, { index: 0, total: 3 }),
      /* shouldReplace */ true
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("a multi-part opening chunk with an EXPLICIT empty slice still clears (tiling rides its own chunks)", async () => {
    // Contrast the absent-field case above: an EXPLICIT `[]` is what
    // `chunkOversizedSession.baseFor` stamps on a PAGINATED chunk 0 whose tiling
    // rows ride later chunks, so it MUST still delete the prior revision's tiling.
    const { tx, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith([], { index: 0, total: 3 }),
      /* shouldReplace */ true
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("an UNCHUNKED empty tiling still no-ops even with shouldReplace (never wipes)", async () => {
    // Backward-compat guard: a whole-session (no chunk marker) empty payload must
    // NOT wipe, exactly as before ISS-4541 — the multi-part wipe is gated on a
    // genuine `chunk.total > 1` sequence.
    const { tx, deleteMany, createMany } = makeTx(5);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith([]),
      /* shouldReplace */ true
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("an UNCHUNKED session with shouldReplace=false still REPLACE-alls (never drops the tiling into the append lane)", async () => {
    // ISS-4578 regression: `shouldReplace` keys on the events-lane `dataRevision`,
    // which is a DIFFERENT lifecycle from the tiling's `classifierVersion`. An
    // unchunked whole session whose revision equals the committed one — or that
    // carries NO `dataRevision` at all (older desktop / first backfill sync) —
    // gets `shouldReplace = false` from `resolveChunkGating`, yet it is NOT a
    // later chunk. It must REPLACE-all through the version-guarded replace lane,
    // not fall into the append lane where the absent stored version
    // (`storedVersion: null`) would silently drop the ENTIRE tiling (the cloud
    // branch-parity failure: activities empty, all spend unattributed).
    const { tx, deleteMany, createMany } = makeTx(null);
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      // No `chunk` marker: an unchunked whole session.
      sessionWith([row({ startMs: 0, endMs: 1000, version: 1 })]),
      /* shouldReplace */ false
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    // The append-lane skip warning must NOT fire — this went through replace.
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("backward compat: an OLD desktop replicating the full tiling in every chunk stays correct", async () => {
    // An old desktop rides the WHOLE tiling in every chunk. Chunk 0 replace-alls
    // it; a later chunk (shouldReplace=false) re-sends the SAME full tiling and
    // appends with skipDuplicates (all startMs collide) — still exactly-once. The
    // stored version is 4 (chunk 0's), matching the re-sent full tiling's version.
    const { tx, deleteMany, createMany } = makeTx(4);
    const fullTiling = [
      row({ startMs: 0, endMs: 1000 }),
      row({ startMs: 1000, endMs: 2000 }),
    ];
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith(fullTiling, { index: 0, total: 2 }),
      /* shouldReplace */ true
    );
    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      chunkedSessionWith(fullTiling, { index: 1, total: 2 }),
      /* shouldReplace */ false
    );
    // One delete (chunk 0); the re-sent full tiling on chunk 1 appends with
    // skipDuplicates so the DB stores each startMs once.
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[1]?.[0].skipDuplicates).toBe(true);
  });
});
