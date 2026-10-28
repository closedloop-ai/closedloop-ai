import { DISPLAYED_STATUS_PARITY_CASES } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freezeParityClock,
  toRecord,
} from "@/__tests__/support/agent-sessions/displayed-status-facet.test-harness";
import { projectDisplayedSessionStatus } from "./session-status-projection";

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

/**
 * ISS-4556 / ISS-4559: the shared DISPLAY oracle — every case in
 * `DISPLAYED_STATUS_PARITY_CASES`, which desktop drives against its own
 * projection, run against the cloud one.
 *
 * ISS-10742: the per-viewer `sessions-displayed-status-parity` GATE cases that
 * used to sit below this loop went with the gate. They pinned
 * `createMemoizedFeatureFlagGate` behaviour — memoization, the
 * hold-on-unavailable fallback, the fail-closed cold start, LRU eviction — not
 * anything about this projection, and that module still has a live consumer, so
 * they moved to its own suite
 * (`apps/api/lib/memoized-feature-flag-gate-decisions.test.ts`) rather than
 * being deleted with their caller.
 */
describe("Sessions displayed-status parity (ISS-4556 / ISS-4559)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ISS-4559 (whitlockk review): these are staleness cases, so the fixture's
    // anchors and the projection's own cutoff must read ONE instant.
    freezeParityClock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ISS-9939 / ISS-10629 (2026-09-17): the sibling FILTER-parity assertion that
  // used to run inside this loop ("returns the row from exactly the facet it
  // displays") is RETIRED. The operator ruling collapsed the Sessions status
  // FILTER to a plain equality against the three PERSISTED SESSION_STATUS
  // values, so the "row is returned by exactly the facet its badge names"
  // property no longer holds for Waiting/Stale/Unknown — by design, not
  // regression. DISPLAY is unchanged, which is the loop below.
  for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
    it(`projects the displayed status: ${parityCase.name}`, () => {
      expect(projectDisplayedSessionStatus(toRecord(parityCase))).toBe(
        parityCase.displayedStatus
      );
    });
  }

  // ISS-6463 deleted the two null-lastActivityAt parity cases that sat here (a
  // fresh start time staying in Active, a stale one moving to Stale). Both
  // described a CLOUD row whose activity timestamp was null; the column is NOT
  // NULL now, so the facet predicates they exercised can no longer meet such a
  // row. Their own comments already noted desktop could not produce this shape
  // either, which is why they were never in the shared oracle.
  //
  // The partition itself is not left uncovered: DISPLAYED_STATUS_PARITY_CASES
  // above drives the same Active/Stale complementarity on rows carrying a real
  // activity timestamp, which is every row.
});
