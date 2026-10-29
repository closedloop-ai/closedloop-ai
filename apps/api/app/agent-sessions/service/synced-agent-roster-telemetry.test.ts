/**
 * ISS-7360 — the `flushedBy` facet must name the cause the throttle ACTUALLY
 * reported.
 *
 * `FixedWindowEmissionThrottle` hands its flush handler a third argument saying
 * which of the two terminal paths materialised the count: an LRU `eviction`
 * (the keyspace cap was hit) or an `expiry` drain (a quiet key's closed window
 * was reclaimed). Those are different operational stories — one is keyspace
 * pressure, the other is ordinary quiet — and `flushedBy` is the only facet
 * that tells a query them apart.
 *
 * These drive the exported PRODUCTION throttle instances, so the `onFlush`
 * closures under test are the ones production runs; a test that built its own
 * throttle would pass while the wiring stayed wrong.
 */

import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_MAX_ENTRIES,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";
import {
  CORRUPT_AGENT_ROSTER_EVENT,
  CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET,
  CorruptAgentRosterReason,
  corruptAgentRosterOrgBudget,
  corruptAgentRosterThrottle,
} from "./synced-agent-roster-telemetry";

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

const ORGANIZATION_ID = "org-7360";
const SESSION_ID = "session-7360";
const KEY_DELIMITER = "|";

type RosterParts = {
  organizationId: string;
  sessionId: string;
  reason: CorruptAgentRosterReason;
};

function buildParts(sessionId: string): RosterParts {
  return {
    organizationId: ORGANIZATION_ID,
    sessionId,
    reason: CorruptAgentRosterReason.UnreadableMembers,
  };
}

function keyFor(parts: RosterParts): string {
  return [parts.organizationId, parts.sessionId, parts.reason].join(
    KEY_DELIMITER
  );
}

type RosterScope = {
  organizationId: string;
  reason: CorruptAgentRosterReason;
};

function buildScope(organizationId: string): RosterScope {
  return {
    organizationId,
    reason: CorruptAgentRosterReason.UnreadableMembers,
  };
}

function scopeKeyFor(scope: RosterScope): string {
  return [scope.organizationId, scope.reason].join(KEY_DELIMITER);
}

function rollups(): [string, Record<string, unknown>][] {
  const calls = vi.mocked(log.warn).mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][];
  return calls.filter(([event]) => event === CORRUPT_AGENT_ROSTER_EVENT);
}

describe("corrupt-roster rollup cause (ISS-7360)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    corruptAgentRosterThrottle.clear();
    corruptAgentRosterOrgBudget.clear();
  });

  /**
   * A burst that ENDS INSIDE ITS WINDOW, drained later by expiry. The rollup
   * must say `expiry`; saying `eviction` reports keyspace pressure that never
   * happened, on a map holding exactly one key.
   */
  it("stamps a drained rollup as expiry, not as an eviction that never happened", () => {
    const parts = buildParts(SESSION_ID);

    // Four occurrences inside one window, then quiet: the per-window budget
    // emits the first and leaves THREE suppressed and pending.
    for (let index = 0; index < 4; index += 1) {
      corruptAgentRosterThrottle.record(keyFor(parts), parts, index);
    }
    // Nothing has been emitted yet — the burst's own line is written by
    // `reportCorruptAgentRoster`, not by `record`.
    expect(rollups()).toHaveLength(0);

    corruptAgentRosterThrottle.drainExpired(
      FIXED_WINDOW_EMISSION_WINDOW_MS * 2
    );

    expect(rollups()).toHaveLength(1);
    expect(rollups()[0][1]).toEqual({
      organizationId: ORGANIZATION_ID,
      sessionId: SESSION_ID,
      reason: CorruptAgentRosterReason.UnreadableMembers,
      occurrences: 3,
      aggregated: true,
      flushedBy: EmissionRollupCause.Expiry,
    });
  });

  /**
   * The positive sibling, and the gap ISS-7360 names outright: no test anywhere
   * asserted `flushedBy: "eviction"`, so the eviction cause was unpinned in
   * both directions — nothing proved a real eviction still says `eviction`.
   */
  it("stamps an LRU-evicted rollup as eviction", () => {
    const victim = buildParts(SESSION_ID);

    corruptAgentRosterThrottle.record(keyFor(victim), victim, 0);
    corruptAgentRosterThrottle.record(keyFor(victim), victim, 1);
    corruptAgentRosterThrottle.record(keyFor(victim), victim, 2);

    // Fill past the cap with DISTINCT sessions inside the same window, so the
    // victim leaves by the keyspace cap rather than by any clock.
    for (let index = 0; index < FIXED_WINDOW_EMISSION_MAX_ENTRIES; index += 1) {
      const intruder = buildParts(`session-intruder-${index}`);
      corruptAgentRosterThrottle.record(keyFor(intruder), intruder, 3);
    }

    // The eviction this case is ABOUT actually happened: cap+1 distinct keys
    // went in and the map is back AT the cap, so exactly one key was dropped. A
    // fixture that under-filled would evict nothing and prove nothing about the
    // cause, silently.
    expect(corruptAgentRosterThrottle.size).toBe(
      FIXED_WINDOW_EMISSION_MAX_ENTRIES
    );

    expect(rollups()).toHaveLength(1);
    expect(rollups()[0][1]).toEqual({
      organizationId: ORGANIZATION_ID,
      sessionId: SESSION_ID,
      reason: CorruptAgentRosterReason.UnreadableMembers,
      occurrences: 2,
      aggregated: true,
      flushedBy: EmissionRollupCause.Eviction,
    });
  });

  /**
   * The SECOND production wiring. Both throttles in this module route their
   * flush through the same `emitAggregate`, so a fix applied to only one of
   * them — or reverted on only one of them — leaves the other silently
   * mislabelling. Driving just the session throttle left this closure with no
   * coverage at all, before or after ISS-7360.
   *
   * Also pins the rollup's SHAPE for the coarse key: the org budget's scope has
   * no `sessionId`, because the occurrences it suppressed did not share one.
   */
  it("stamps the org budget's drained rollup as expiry, with no sessionId", () => {
    const scope = buildScope(ORGANIZATION_ID);

    // TWO past the budget: the first ten spend it, the last two are suppressed.
    for (
      let index = 0;
      index < CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET + 2;
      index += 1
    ) {
      corruptAgentRosterOrgBudget.record(scopeKeyFor(scope), scope, index);
    }

    corruptAgentRosterOrgBudget.drainExpired(
      FIXED_WINDOW_EMISSION_WINDOW_MS * 2
    );

    expect(rollups()).toHaveLength(1);
    expect(rollups()[0][1]).toEqual({
      organizationId: ORGANIZATION_ID,
      reason: CorruptAgentRosterReason.UnreadableMembers,
      occurrences: 2,
      aggregated: true,
      flushedBy: EmissionRollupCause.Expiry,
    });
  });

  /**
   * The org budget's EVICTION sibling (#5557 review, whitlockk). The expiry case
   * above pins this closure in one direction only: a handler that stamped every
   * flush `expiry` — the constant ISS-7360 removed — keeps that case green while
   * telling an operator that real keyspace pressure was ordinary quiet. This is
   * the coarse key an org's own churn can drive to the cap, so `eviction` is
   * exactly the story that must survive here.
   */
  it("stamps the org budget's LRU-evicted rollup as eviction", () => {
    const victim = buildScope(ORGANIZATION_ID);

    // TWO past the budget again, so the victim is carrying a pending count when
    // the cap comes for it.
    for (
      let index = 0;
      index < CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET + 2;
      index += 1
    ) {
      corruptAgentRosterOrgBudget.record(scopeKeyFor(victim), victim, index);
    }
    expect(corruptAgentRosterOrgBudget.size).toBe(1);
    // Nothing has been flushed yet, so the single rollup asserted below is the
    // eviction's and cannot be the burst's.
    expect(rollups()).toHaveLength(0);

    // Fill past the cap with DISTINCT ORG scopes inside the same window, so the
    // victim leaves by the keyspace cap rather than by any clock.
    for (let index = 0; index < FIXED_WINDOW_EMISSION_MAX_ENTRIES; index += 1) {
      const intruder = buildScope(`org-intruder-${index}`);
      corruptAgentRosterOrgBudget.record(scopeKeyFor(intruder), intruder, 3);
    }

    // The eviction this case is ABOUT actually happened: cap+1 distinct keys
    // went in and the map is back AT the cap, so exactly one key was dropped. A
    // fixture that under-filled would evict nothing and prove nothing about the
    // cause, silently.
    expect(corruptAgentRosterOrgBudget.size).toBe(
      FIXED_WINDOW_EMISSION_MAX_ENTRIES
    );

    expect(rollups()).toHaveLength(1);
    expect(rollups()[0][1]).toEqual({
      organizationId: ORGANIZATION_ID,
      reason: CorruptAgentRosterReason.UnreadableMembers,
      occurrences: 2,
      aggregated: true,
      flushedBy: EmissionRollupCause.Eviction,
    });
  });
});
