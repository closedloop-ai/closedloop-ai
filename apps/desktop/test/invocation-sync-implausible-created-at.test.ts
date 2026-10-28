/**
 * @file invocation-sync-implausible-created-at.test.ts
 * @description ISS-8566 — a `created_at` the lane can READ but that cannot be this
 * row's creation instant, in either direction.
 *
 * Its own suite rather than more blocks in `invocation-sync-corrupt-created-at.test.ts`,
 * whose header explains that it deliberately holds no classification-only case: that
 * file proves the ISS-6209 wedge against a real store, and a classification assertion
 * there would restate a value instead of a queue unblocking. What ISS-8566 changed is
 * the CLASSIFICATION itself — which readable values are corrupt — so the band and its
 * two edges are what this file pins, plus the production lookup that turns the state
 * into a budget and a terminal cause.
 *
 * The two failures are opposite and both terminal for the session, not just the row:
 * a future timestamp ages NEGATIVE, never reaches the horizon, and pins at `Within`
 * forever, which is the permanent promotion wedge; an epoch timestamp ages as decades
 * and terminalizes on ack one under a cause claiming a retry history it never had.
 */
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentComponentInvocationSyncLocalError } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import {
  classifySessionMissingRetryHorizon,
  rejectionBudgetForRow,
  SESSION_MISSING_FUTURE_SKEW_TOLERANCE_MS,
  SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS,
  SESSION_MISSING_MAX_RETRY_AGE_MS,
  SESSION_MISSING_MIN_PLAUSIBLE_CREATED_AT_MS,
  SessionMissingRetryHorizon,
  terminalCauseForRejection,
} from "../src/main/agent-sync/invocation-sync-rejection-policy.js";

/** The reading clock every case is judged against. */
const NOW = "2026-07-22T17:00:00.000Z";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A `created_at` at a given offset from the PINNED clock, so every fixture is
 * derived from the same instant the classifier reads rather than hand-written
 * beside it.
 */
function createdAtOffsetFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("ISS-8566 implausible `created_at` in the session_missing horizon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a future `created_at` instead of pinning it inside the horizon", () => {
    // The shape the incident carried: a row written while the machine clock ran
    // forward. Its age is negative, so no horizon comparison can ever fire.
    expect(
      classifySessionMissingRetryHorizon("2035-01-01T00:00:00.000Z", Date.now())
    ).toBe(SessionMissingRetryHorizon.InvalidTimestamp);
  });

  it("refuses a dead-RTC epoch `created_at` instead of calling it outlived", () => {
    expect(
      classifySessionMissingRetryHorizon("1970-01-01T00:00:00.000Z", Date.now())
    ).toBe(SessionMissingRetryHorizon.InvalidTimestamp);
  });

  it("still classifies normally just inside the future-skew tolerance", () => {
    const justSkewed = createdAtOffsetFromNow(
      SESSION_MISSING_FUTURE_SKEW_TOLERANCE_MS - 1000
    );
    expect(classifySessionMissingRetryHorizon(justSkewed, Date.now())).toBe(
      SessionMissingRetryHorizon.Within
    );
  });

  it("refuses a `created_at` one second past the future-skew tolerance", () => {
    // The other side of the same edge: without it, "still classifies normally"
    // above would pass against a band that admits everything.
    const pastTolerance = createdAtOffsetFromNow(
      SESSION_MISSING_FUTURE_SKEW_TOLERANCE_MS + 1000
    );
    expect(classifySessionMissingRetryHorizon(pastTolerance, Date.now())).toBe(
      SessionMissingRetryHorizon.InvalidTimestamp
    );
  });

  it("leaves a genuinely outlived four-day-old row outlived", () => {
    const fourDaysOld = createdAtOffsetFromNow(-4 * ONE_DAY_MS);
    expect(4 * ONE_DAY_MS).toBeGreaterThan(SESSION_MISSING_MAX_RETRY_AGE_MS);
    expect(classifySessionMissingRetryHorizon(fourDaysOld, Date.now())).toBe(
      SessionMissingRetryHorizon.Outlived
    );
  });

  it("leaves a row one day above the calendar floor outlived", () => {
    // The past edge must not eat the population it sits above: a row parked through
    // a very long outage is old, not corrupt.
    const justAboveFloor = new Date(
      SESSION_MISSING_MIN_PLAUSIBLE_CREATED_AT_MS + ONE_DAY_MS
    ).toISOString();
    expect(classifySessionMissingRetryHorizon(justAboveFloor, Date.now())).toBe(
      SessionMissingRetryHorizon.Outlived
    );
  });

  it("refuses a row one day below the calendar floor", () => {
    // The other side of that edge, so the case above cannot pass against a floor
    // that admits everything.
    const justBelowFloor = new Date(
      SESSION_MISSING_MIN_PLAUSIBLE_CREATED_AT_MS - ONE_DAY_MS
    ).toISOString();
    expect(classifySessionMissingRetryHorizon(justBelowFloor, Date.now())).toBe(
      SessionMissingRetryHorizon.InvalidTimestamp
    );
  });

  it("leaves a row that waited years past the retry horizon outlived, not corrupt", () => {
    // Review (davetho): age alone cannot separate an honestly-old pending row
    // from a wrong clock, and an age band eventually claims the first because the
    // row keeps aging into it. Three years is far past the previous one-year band
    // and must still be `Outlived`, on `Outlived`'s budget and terminal cause —
    // never a `CorruptCreatedAt` quarantine finding.
    const threeYearsOld = createdAtOffsetFromNow(-3 * 365 * ONE_DAY_MS);
    expect(classifySessionMissingRetryHorizon(threeYearsOld, Date.now())).toBe(
      SessionMissingRetryHorizon.Outlived
    );
    const budget = rejectionBudgetForRow({
      reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
      createdAt: threeYearsOld,
      nowMs: Date.now(),
    });
    expect(budget.sessionMissingHorizon).toBe(
      SessionMissingRetryHorizon.Outlived
    );
    expect(
      terminalCauseForRejection({
        ackReason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        horizon: budget.sessionMissingHorizon,
      })
    ).not.toBe(AgentComponentInvocationSyncLocalError.CorruptCreatedAt);
  });

  it("leaves a within-horizon row within", () => {
    const oneHourOld = createdAtOffsetFromNow(-60 * 60 * 1000);
    expect(classifySessionMissingRetryHorizon(oneHourOld, Date.now())).toBe(
      SessionMissingRetryHorizon.Within
    );
  });

  it("prices a future `created_at` as a reported quarantine, not a silent defer", () => {
    // The production lookup, not the classifier: this is what actually unwedges the
    // delivery queue (`permanent`) and what makes the row visible to the
    // store-integrity probe (the `CorruptCreatedAt` cause it counts).
    const budget = rejectionBudgetForRow({
      reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
      createdAt: "2035-01-01T00:00:00.000Z",
      nowMs: Date.now(),
    });
    expect(budget.permanent).toBe(true);
    expect(budget.maxAttempts).toBe(
      SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS
    );
    expect(budget.sessionMissingHorizon).toBe(
      SessionMissingRetryHorizon.InvalidTimestamp
    );
    expect(
      terminalCauseForRejection({
        ackReason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        horizon: budget.sessionMissingHorizon,
      })
    ).toBe(AgentComponentInvocationSyncLocalError.CorruptCreatedAt);
  });

  it("gives the epoch row a real attempt budget instead of terminalizing on ack one", () => {
    const budget = rejectionBudgetForRow({
      reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
      createdAt: "1970-01-01T00:00:00.000Z",
      nowMs: Date.now(),
    });
    expect(budget.maxAttempts).toBe(
      SESSION_MISSING_INVALID_TIMESTAMP_MAX_ATTEMPTS
    );
    expect(budget.maxAttempts).toBeGreaterThan(1);
  });
});
