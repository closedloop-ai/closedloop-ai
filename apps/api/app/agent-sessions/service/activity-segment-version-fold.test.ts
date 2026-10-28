/**
 * ISS-8330 Section 6: the tiling's incoming-version reduction must be a fold,
 * not a `Math.max(...)` spread.
 *
 * ISS-8051 removed the receive-side `.max()` that used to bound
 * `activitySegmentRows`, naming the request byte ceiling as the replacement.
 * That ceiling admits far more rows than a spread can take arguments, so the
 * spread threw `RangeError: Maximum call stack size exceeded` — deterministic,
 * so the session re-threw it on every retry. The bound belongs at the fold; the
 * array cap stays removed.
 */
import type {
  SyncedActivitySegmentRow,
  SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistSessionActivitySegments } from "./activity-segment-persistence";
import type { AgentSessionUpsertTx } from "./records";

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

/**
 * Sized to the RUNNER's stack, not production's, and that gap is the point.
 *
 * A plain `node` process throws at 150,000 spread arguments (125,000 is fine) —
 * the production figure, and well inside the ~180,000 rows
 * `SYNC_DECOMPRESSED_BYTE_CEILING` admits for rows of this shape. A Vitest
 * worker runs on a larger stack and does not throw until somewhere between
 * 400,000 and 500,000, so a 200,000-row fixture passes here WITH the spread
 * still in place and proves nothing. Measured in this worktree, not assumed.
 */
const SPREAD_BREAKING_ROW_COUNT = 500_000;

function makeTx(storedVersion: number | null = null) {
  const findFirst = vi
    .fn()
    .mockResolvedValue(
      storedVersion === null ? null : { classifierVersion: storedVersion }
    );
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  // Call COUNTER, not a `vi.fn()`: a spy retains every argument it is handed,
  // which for the wide fixture below would hold all 500,000 mapped rows alive
  // for the life of the assertion.
  let createManyCalls = 0;
  const createMany = () => {
    createManyCalls += 1;
    return Promise.resolve({ count: 0 });
  };
  const tx = {
    agentSessionActivitySegment: { findFirst, deleteMany, createMany },
  } as unknown as AgentSessionUpsertTx;
  return {
    tx,
    findFirst,
    deleteMany,
    createManyCallCount: () => createManyCalls,
  };
}

function rowAt(index: number, version: number): SyncedActivitySegmentRow {
  return {
    phase: "implement",
    startMs: index * 10,
    endMs: index * 10 + 5,
    confidence: 0.8,
    evidenceLayers: ["structural"],
    version,
    workItemRef: null,
    subagentId: null,
  };
}

function sessionWith(rows: SyncedActivitySegmentRow[]): SyncedAgentSession {
  return { activitySegmentRows: rows } as unknown as SyncedAgentSession;
}

// Versions deliberately unsorted, with the maximum in the MIDDLE: a fold that
// took the first or the last element instead of the greatest would pick 3 or 5
// and flip both version-gate assertions below.
const UNSORTED_VERSIONS = [3, 7, 5];
const EXPECTED_MAX_VERSION = 7;

describe("activity-segment incoming version is folded, not spread (ISS-8330)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the maximum version across the slice, not the first or last row", async () => {
    // Stored version equals the true max, so the replace is NOT stale and
    // proceeds. Had the fold returned 3 or 5, this would take the stale-skip
    // branch and write nothing.
    const { tx, createManyCallCount } = makeTx(EXPECTED_MAX_VERSION);

    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith(UNSORTED_VERSIONS.map((v, i) => rowAt(i, v)))
    );

    expect(createManyCallCount()).toBeGreaterThan(0);
  });

  it("skips the replace when the folded maximum is below the stored version", async () => {
    // One above the true max: the slice IS stale, so nothing is deleted or
    // written. A fold returning 3 or 5 would also skip here, which is why the
    // test above is the one that pins the value.
    const { tx, deleteMany, createManyCallCount } = makeTx(
      EXPECTED_MAX_VERSION + 1
    );

    await persistSessionActivitySegments(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      sessionWith(UNSORTED_VERSIONS.map((v, i) => rowAt(i, v)))
    );

    expect(deleteMany).not.toHaveBeenCalled();
    expect(createManyCallCount()).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledWith(
      "activity-segment tiling is older than the stored tiling; skipping stale replace",
      expect.objectContaining({ incomingVersion: EXPECTED_MAX_VERSION })
    );
  });

  it("persists a slice far wider than the argument limit instead of throwing", async () => {
    const { tx, createManyCallCount } = makeTx(1);
    const rows = Array.from({ length: SPREAD_BREAKING_ROW_COUNT }, (_, index) =>
      rowAt(index, 1)
    );

    // The assertion is that this RESOLVES. Before the fold it rejected with
    // `RangeError: Maximum call stack size exceeded` at the spread, before any
    // statement was issued.
    await expect(
      persistSessionActivitySegments(
        tx,
        ARTIFACT_ID,
        ORGANIZATION_ID,
        sessionWith(rows)
      )
    ).resolves.toBe(true);

    expect(createManyCallCount()).toBeGreaterThan(0);
  });
});
