/**
 * ISS-7387 — a producer-side `lastActiveCohort` regression must not be silent.
 *
 * The client drops a present-but-invalid cohort to `undefined` (PR #5492) and
 * that degradation is correct, so nothing user-facing distinguishes a producer
 * that regressed from a producer that simply omitted the field. This suite is
 * the signal that does, in both directions: an invalid cohort reports, and a
 * VALID one stays silent — an always-on alarm would be no better than none.
 *
 * Asserting on a log call is normally forbidden by the repo's test practices.
 * The documented exception applies: here the emitted signal IS the contract
 * under test, exactly as in `branch-analytics-kpis.test.ts`.
 */
import {
  BranchListCohortScope,
  branchLastActiveCohortSchema,
} from "@repo/api/src/types/branch-list-cohort";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";
import {
  BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
  buildBranchLastActiveCohort,
  resetBranchLastActiveCohortThrottle,
} from "./branch-last-active-cohort";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** The module owns the literal; a second spelling here could drift off it. */
const EVENT = BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT;
const ORGANIZATION_ID = "org_last_active_cohort";
const EVALUATION_NOW = new Date("2026-07-03T05:00:00.000Z");
const CONTEXT = { organizationId: ORGANIZATION_ID };

function build(overrides: { total: number; cohortKey?: string }) {
  return buildBranchLastActiveCohort(
    {
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: overrides.cohortKey ?? '{"status":["open"]}',
      evaluationNow: EVALUATION_NOW,
      total: overrides.total,
      retainedUnavailable: 0,
    },
    CONTEXT
  );
}

describe("buildBranchLastActiveCohort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBranchLastActiveCohortThrottle();
    // The throttle's windows are read off the clock, so the suite pins it —
    // otherwise the drain case below would depend on how long the run took.
    vi.useFakeTimers();
    vi.setSystemTime(EVALUATION_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays silent on a well-formed cohort", () => {
    const cohort = build({ total: 4 });

    expect(log.warn).not.toHaveBeenCalled();
    expect(branchLastActiveCohortSchema.safeParse(cohort).success).toBe(true);
    expect(cohort.knownInWindow).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4,
    });
  });

  it("stays silent on a zero-branch cohort, which is empty and not corrupt", () => {
    build({ total: 0 });

    expect(log.warn).not.toHaveBeenCalled();
  });

  // The constructor is not the guarantee it looks like: its own `clampCount`
  // admits `0 <= 0 <= 1.5`, so a fractional total passes straight through it and
  // out onto the wire. No production caller supplies one today (the page total
  // comes off a BigInt count), which is exactly why it belongs here and not in
  // the wiring suite — this pins the DETECTOR, `reports a cohort the maxed-out
  // filter set made invalid` pins the live path.
  it("reports a non-integer total, which the constructor cannot reject", () => {
    build({ total: 1.5 });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        scope: BranchListCohortScope.RequestFilters,
        total: 1.5,
      })
    );
  });

  it("names the offending field so the producer bug is findable", () => {
    build({ total: 1.5 });

    const [, meta] = vi.mocked(log.warn).mock.calls[0] as [
      string,
      { issues: { code: string; path: string }[] },
    ];
    expect(meta.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["total"])
    );
  });

  it("reports a cohortKey past the schema's size bound", () => {
    build({ total: 2, cohortKey: "x".repeat(16_385) });

    expect(log.warn).toHaveBeenCalledWith(EVENT, expect.any(Object));
  });

  // `cohortKey` serializes the caller's filter values — branch names, repository
  // names, owner logins. Its LENGTH is the diagnosable part; the key itself must
  // not reach the log sink.
  it("carries the cohortKey's length but never the key", () => {
    const cohortKey = `{"names":["${"secret-branch".repeat(1400)}"]}`;
    build({ total: 2, cohortKey });

    const [, meta] = vi.mocked(log.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(meta.cohortKeyLength).toBe(cohortKey.length);
    expect(JSON.stringify(meta)).not.toContain("secret-branch");
  });

  // Branches List is polled every 120s and the `cohortKey` overflow is
  // reachable through ordinary UI use, so an unthrottled warn would let one
  // member holding one large filter set emit forever. The repeat must be
  // counted, not dropped — a `sum(occurrences)` query has to stay honest.
  it("reports one repeated violation once, counting the rest", () => {
    const overflowKey = "x".repeat(16_385);
    build({ total: 2, cohortKey: overflowKey });
    build({ total: 2, cohortKey: overflowKey });
    build({ total: 2, cohortKey: overflowKey });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ occurrences: 1 })
    );
  });

  // The suppressed count is materialised by an EVENT, never a clock. This is
  // the one this module owns: `buildBranchLastActiveCohort` drains on EVERY
  // list request, so a burst that then goes quiet on its own key is still
  // flushed. Without the drain the two suppressed occurrences below sit in
  // memory until that exact org repeats that exact violation.
  it("flushes a quiet key's suppressed count on the next list request", () => {
    const overflowKey = "x".repeat(16_385);
    build({ total: 2, cohortKey: overflowKey });
    build({ total: 2, cohortKey: overflowKey });
    build({ total: 2, cohortKey: overflowKey });
    vi.mocked(log.warn).mockClear();

    // Any later request drains it — this one is a DIFFERENT org with a
    // perfectly valid cohort, which emits nothing of its own.
    vi.setSystemTime(
      new Date(EVALUATION_NOW.getTime() + FIXED_WINDOW_EMISSION_WINDOW_MS + 1)
    );
    buildBranchLastActiveCohort(
      {
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: '{"status":["open"]}',
        evaluationNow: EVALUATION_NOW,
        total: 4,
        retainedUnavailable: 0,
      },
      { organizationId: "org_unrelated_reader" }
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        occurrences: 2,
        aggregated: true,
        flushedBy: EmissionRollupCause.Expiry,
      })
    );
  });

  // A multi-issue violation is still ONE signature, so the second identical
  // cohort is throttled rather than buying its own budget off the longer issue
  // list. The signature's CAP is not asserted here on purpose: with a typed
  // constructor in front of a fixed schema, no reachable cohort produces more
  // than three issues, so a case claiming to exercise the cap would be green
  // whatever the cap was. The cap is a forward guard for a schema that grows a
  // nested array; what is reachable today — that a longer issue list collapses
  // to one key — is what this pins.
  it("keeps a multi-issue violation on a single key", () => {
    build({ total: 1.5, cohortKey: "x".repeat(16_385) });

    const [, first] = vi.mocked(log.warn).mock.calls[0] as [
      string,
      { issues: { code: string; path: string }[] },
    ];
    expect(first.issues.length).toBeGreaterThan(1);

    build({ total: 1.5, cohortKey: "x".repeat(16_385) });

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // The throttle must not become a mute button: a violation the previous one
  // does not describe is new information and reports immediately.
  it("still reports a DIFFERENT violation inside the same window", () => {
    build({ total: 2, cohortKey: "x".repeat(16_385) });
    build({ total: 1.5 });

    expect(log.warn).toHaveBeenCalledTimes(2);
    // Both reported, and they described different violations — the first call's
    // window did not swallow the second. Compared as SETS of issue paths rather
    // than a pinned first-issue name, because which field Zod reports first is
    // its own ordering detail, not this throttle's contract.
    const signatures = vi
      .mocked(log.warn)
      .mock.calls.map(([, meta]) =>
        (meta as { issues: { path: string }[] }).issues
          .map((issue) => issue.path)
          .join(",")
      );
    expect(signatures[0]).toContain("cohortKey");
    expect(signatures[1]).not.toContain("cohortKey");
    expect(signatures[0]).not.toEqual(signatures[1]);
  });

  // Detection only: #5492's graceful degradation is the client's job and this
  // must not start editing the wire value under it.
  it("returns the cohort untouched so the wire shape is unchanged", () => {
    const cohort = build({ total: 1.5 });

    expect(cohort.total).toBe(1.5);
    expect(cohort.knownInWindow).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1.5,
    });
    expect(cohort.evaluationNow).toBe(EVALUATION_NOW.toISOString());
  });
});
