import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ ChecksStatus: { UNKNOWN: "UNKNOWN" } });
});

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { findSessionDetail: vi.fn() },
}));

import {
  branchId,
  branchIdB,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { failedPenseroDayFindFirst } from "@/__tests__/support/branches/pensero-failed-day-ledger.test-fixtures";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

/** The org's one day it attempted and never retrieved. */
const FAILED_DAY = new Date("2026-06-12T00:00:00.000Z");
const PENSERO_POINTS = {
  points: 20,
  hasAmbiguousPoints: false,
  hasUnreadablePointValues: false,
};

/**
 * ISS-10653, Perrin Upcott's ruling 2026-09-29: a branch card names the failed
 * day only when it falls inside that branch's own activity window.
 *
 * Two branches in ONE org against ONE ledger, because a single branch cannot
 * tell a window-bounded probe from the org-wide one. Both go through the real
 * detail read, the real ledger predicate and the real disclosure mapping.
 */
describe("branchReadService — ISS-10653 failed-day disclosure window", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    Object.assign(mockDb, {
      penseroBackfillDay: {
        findFirst: vi.fn(failedPenseroDayFindFirst(organizationId, FAILED_DAY)),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A's window holds the failed day, B's does not; both publish the number", async () => {
    const a = await detailWithSessionStartedAt(
      branchId,
      "2026-06-10T10:00:00.000Z"
    );
    const b = await detailWithSessionStartedAt(
      branchIdB,
      "2026-06-20T10:00:00.000Z"
    );

    // The windows the probe is bounded by: each branch's earliest session.
    expect(a?.leadTime.firstActivityT).toBe("2026-06-10T10:00:00.000Z");
    expect(b?.leadTime.firstActivityT).toBe("2026-06-20T10:00:00.000Z");
    // 20 points over each branch's own $1.
    expect(a?.canonicalMetrics?.penseroPointsPerDollar).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 20,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
    });
    expect(b?.canonicalMetrics?.penseroPointsPerDollar).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 20,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
  });

  async function detailWithSessionStartedAt(id: string, startedAt: string) {
    // The four candidate reads `mockDetailCandidateSnapshots` queues, answered
    // for THIS branch so its cost divisor is its own.
    for (let read = 0; read < 4; read++) {
      mockBranchCandidateIds(mockDb, [id]);
    }
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow({ id }));
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(id, `session-${id}`, "1.00", null, null, null, {
          sessionStartedAt: new Date(startedAt),
        }),
      ])
      .mockResolvedValueOnce([{ sourceId: `session-${id}`, targetId: id }]);
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: `session-${id}`,
        phase: "plan",
        startMs: Date.parse(startedAt),
        endMs: Date.parse(startedAt) + 90_000,
        confidence: 0.9,
      },
    ]);
    return await branchReadService.getBranchDetail(
      organizationId,
      id,
      undefined,
      undefined,
      { penseroPoints: PENSERO_POINTS }
    );
  }
});
