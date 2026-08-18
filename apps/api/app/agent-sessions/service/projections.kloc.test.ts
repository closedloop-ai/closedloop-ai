// FEA-4250: server-side per-session KLOC + KLOC/$ projection tests. Split out of
// projections.test.ts (grandfathered over the 1000-line ceiling) so the KLOC
// rollup coverage lives in its own sibling. Asserts the values the list/detail
// read contract now carries — derived from the session's real diff stats — and
// the honest-null paths for a session with no lines or no cost.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

async function projectFirstSession(
  overrides: Record<string, unknown>
): Promise<{ kloc?: number | null; locPerDollar?: number | null }> {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([buildSessionListRecord(overrides)]),
      count: vi.fn().mockResolvedValue(1),
    },
  });
  const result = await agentSessionsService.findSessions({
    organizationId: "org-1",
    filters: {},
  });
  const item = result.items[0];
  return { kloc: item?.kloc, locPerDollar: item?.locPerDollar };
}

describe("agentSessionsService per-session KLOC projection (FEA-4250)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // SES-72597: 2,347 lines added + 6 removed with a real cost must NOT read
  // null — kloc ≈ 2.353 and locPerDollar is the raw lines/cost ratio (ISS-4667).
  it("derives kloc and locPerDollar from real diff stats", async () => {
    const { kloc, locPerDollar } = await projectFirstSession({
      linesAdded: 2347,
      linesRemoved: 6,
      estimatedCost: 2415.05,
    });

    expect(kloc).toBeCloseTo(2.353, 10);
    // ISS-4667: 2353 LINES / 2415.05 — no divide-by-1000. Under the old KLOC
    // unit this was 0.00097, which display-rounded to a misleading "0.00".
    expect(locPerDollar).toBeCloseTo(2353 / 2415.05, 12);
  });

  // A session that delivered no lines has no KLOC to report — an honest null,
  // never a fabricated 0. locPerDollar is null in turn.
  it("reports null kloc and locPerDollar when no lines were delivered", async () => {
    const { kloc, locPerDollar } = await projectFirstSession({
      linesAdded: 0,
      linesRemoved: 0,
      estimatedCost: 12.5,
    });

    expect(kloc).toBeNull();
    expect(locPerDollar).toBeNull();
  });

  // Lines but no cost to divide by: kloc is still real, but locPerDollar is an
  // honest null (unpriced / $0 session) rather than an Infinity.
  it("reports kloc but null locPerDollar when the session has no cost", async () => {
    const { kloc, locPerDollar } = await projectFirstSession({
      linesAdded: 1000,
      linesRemoved: 0,
      estimatedCost: 0,
    });

    expect(kloc).toBeCloseTo(1, 10);
    expect(locPerDollar).toBeNull();
  });

  // ISS-4448: the numerator weighs the branch-level diff too, so KLOC/$ matches
  // the detail-view "Lines changed" figure. A merged 88-PR session with a 4,004-
  // line branch diff (3315 + 689) but only a 56-line working-tree residual and no
  // authored-PR LOC must derive KLOC from 4,004, not 56.
  it("uses the branch-level diff in the KLOC numerator when it is the largest signal", async () => {
    const { kloc, locPerDollar } = await projectFirstSession({
      linesAdded: 51,
      linesRemoved: 5,
      branchLocSource: "git",
      branchLinesAdded: 3315,
      branchLinesRemoved: 689,
      branchFilesChanged: 42,
      estimatedCost: 100,
    });

    // 4004 / 1000 = 4.004 KLOC, NOT the 0.056 the 56-line residual would give.
    expect(kloc).toBeCloseTo(4.004, 10);
    // ISS-4667: 4004 LINES / $100 = 40.04 LOC/$.
    expect(locPerDollar).toBeCloseTo(4004 / 100, 12);
  });
});
