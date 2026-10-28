import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The candidate, TYPED AGAINST THE REAL EXPORT rather than left bare.
 *
 * A bare `vi.fn()` accepts any `mockResolvedValue`, so nothing held the
 * fixtures below to the signature they stand in for: a payload missing a
 * required field compiled clean and the suite went green on a shape
 * `buildUsageSummaryFromSql` can never return (marisolashgrove on #7003). The
 * type query names the mocked module in TYPE space only — erased before
 * `vi.mock` hoists, so it cannot defeat the mock the way a value import of
 * the same module would.
 */
const buildUsageSummaryFromSql =
  vi.fn<
    typeof import("@/app/agent-sessions/service/usage-summary-sql").buildUsageSummaryFromSql
  >();
const info = vi.fn();
const warn = vi.fn();

vi.mock("@/app/agent-sessions/service/usage-summary-sql", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/agent-sessions/service/usage-summary-sql")
  >("@/app/agent-sessions/service/usage-summary-sql");
  return { ...actual, buildUsageSummaryFromSql };
});

vi.mock("@repo/observability/log", () => ({ log: { info, warn } }));

const {
  shadowUsageSummary,
  SHADOW_REPORTED_FIELD_CAP,
  USAGE_SQL_SHADOW_EVENT,
  USAGE_SQL_SHADOW_FAILED_EVENT,
} = await import("@/app/agent-sessions/service/usage-summary-shadow");

const live = {
  totalSessions: 64,
  totalEstimatedCost: 10,
} as unknown as AgentSessionUsageSummary;

const input = { organizationId: "org", filters: {} } as never;

/**
 * The shadow RETURNS its promise now (the route hands it to `waitUntil`), so
 * these cases await that promise rather than a timer. The old `settle()` slept
 * on the macrotask queue and passed whether or not the function returned
 * anything, which is why the contract change below went unnoticed.
 */

/**
 * An upper bound a real elapsed time clears and a mutated one cannot.
 *
 * Stryker survived `Date.now() - startedAtMs` -> `+` on all three log branches:
 * every case asserted the payload with `objectContaining`, so the field was
 * emitted and never read. The mutant ships roughly twice the epoch, which no
 * assertion about SHAPE would notice — `expect.any(Number)` passes on it — and
 * which silently poisons any latency query built on this event. A ceiling is
 * what makes the field a duration rather than a number.
 */
const PLAUSIBLE_DURATION_CEILING_MS = 60_000;

/**
 * The `durationMs` off a log call, THROWING when it is not a usable number.
 *
 * Throws rather than asserts because `lint/suspicious/noMisplacedAssertion`
 * forbids an `expect` outside a case — and a helper that returned `NaN` or
 * `undefined` on a missing field would make the single bound at each call site
 * pass vacuously, which is the hole this whole helper exists to close.
 */
function loggedDuration(calls: readonly unknown[], index: number): number {
  const call = calls[index] as [string, Record<string, unknown>] | undefined;
  const duration = call?.[1]?.durationMs;
  if (typeof duration !== "number" || Number.isNaN(duration) || duration < 0) {
    throw new Error(
      `log call ${index} carried no usable durationMs (got ${String(duration)}); the bound at the call site would have passed vacuously`
    );
  }
  return duration;
}

beforeEach(() => {
  buildUsageSummaryFromSql.mockReset();
  info.mockReset();
  warn.mockReset();
});

/**
 * The two event names as LITERALS, because the cases below cannot pin them.
 *
 * ISS-10753 removed the third (SKIPPED) event along with the capped-cohort
 * refusal it reported — every facet is an ordinary SQL predicate now, so
 * there is no longer a comparison that never ran to give its own event.
 *
 * Every assertion in this file spells the event as the imported constant, so a
 * rename moves both sides together and stays green — Stryker confirmed it by
 * blanking both to `""` with the suite passing. These names are the join
 * key for the log queries and dashboards that read this diagnostic, so a silent
 * rename breaks a dashboard with nothing red anywhere. Same defect class as
 * ISS-9941, same fix: one literal oracle the constants are checked against.
 */
describe("shadow event names — the log-query contract", () => {
  it("are exactly the names the dashboards join on", () => {
    expect(USAGE_SQL_SHADOW_EVENT).toBe("sessions_usage_typed_sql_shadow");
    expect(USAGE_SQL_SHADOW_FAILED_EVENT).toBe(
      "sessions_usage_typed_sql_shadow_failed"
    );
  });

  it("are DISTINCT, so a comparison cannot be counted as a failure", () => {
    const names = new Set([
      USAGE_SQL_SHADOW_EVENT,
      USAGE_SQL_SHADOW_FAILED_EVENT,
    ]);
    expect(names.size).toBe(2);
  });
});

describe("shadowUsageSummary", () => {
  it("resolves to nothing, so it cannot change the response", async () => {
    // ISS-8554: the return type changed from `void` to `Promise<void>` when the
    // route moved to `waitUntil`. The value must still be nothing — the route
    // must never be able to read a summary back out of the diagnostic.
    buildUsageSummaryFromSql.mockResolvedValue(live);
    await expect(shadowUsageSummary(input, live)).resolves.toBeUndefined();
  });

  it("returns a THENABLE, which is what waitUntil requires", async () => {
    // `waitUntil` throws a TypeError on a non-thenable, so a regression back to
    // `): void` would fail the request it is supposed to be invisible to.
    buildUsageSummaryFromSql.mockResolvedValue(live);
    const returned = shadowUsageSummary(input, live);
    expect(typeof (returned as { then?: unknown }).then).toBe("function");
    await returned;
  });

  it("swallows a throwing candidate rather than failing the request", async () => {
    // A read path nothing consumes must never be able to 500 a page.
    buildUsageSummaryFromSql.mockRejectedValue(new Error("statement blew up"));
    expect(() => shadowUsageSummary(input, live)).not.toThrow();
    await shadowUsageSummary(input, live);
    expect(warn).toHaveBeenCalledWith(
      USAGE_SQL_SHADOW_FAILED_EVENT,
      expect.objectContaining({ message: "statement blew up" })
    );
    expect(loggedDuration(warn.mock.calls, 0)).toBeLessThan(
      PLAUSIBLE_DURATION_CEILING_MS
    );
    expect(info).not.toHaveBeenCalled();
  });

  it("does not reject when the candidate rejects", async () => {
    buildUsageSummaryFromSql.mockRejectedValue(new Error("boom"));
    // Awaited directly: an unhandled rejection here would surface as a
    // process-level warning in production, which is the quiet version of
    // failing the request. `waitUntil` would propagate it too.
    await expect(shadowUsageSummary(input, live)).resolves.toBeUndefined();
  });

  it("logs the verdict when the candidate matches", async () => {
    buildUsageSummaryFromSql.mockResolvedValue(live);
    await shadowUsageSummary(input, live);
    expect(info).toHaveBeenCalledWith(
      USAGE_SQL_SHADOW_EVENT,
      expect.objectContaining({ defectCount: 0 })
    );
    expect(loggedDuration(info.mock.calls, 0)).toBeLessThan(
      PLAUSIBLE_DURATION_CEILING_MS
    );
  });

  it("names the diverging fields when they differ", async () => {
    buildUsageSummaryFromSql.mockResolvedValue({ ...live, totalSessions: 63 });
    await shadowUsageSummary(input, live);
    const [, payload] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.defectFields).toContain("totalSessions");
    expect(payload.clean).toBe(false);
  });

  it("logs field NAMES only, never values", async () => {
    // Facet arrays carry repository names, models and owner emails. A
    // diagnostic log is the wrong place for any of them.
    buildUsageSummaryFromSql.mockResolvedValue({
      ...live,
      totalEstimatedCost: 999,
    });
    await shadowUsageSummary(input, live);
    const [, payload] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(payload)).not.toContain("999");
    expect(payload.defectFields).toEqual(["totalEstimatedCost"]);
  });

  it("caps the named fields so a wide divergence cannot flood a log line", async () => {
    // Uses the REAL coverage set, because that is what the shadow diffs against
    // — an earlier version of this test invented field names, which the shadow
    // correctly scored as not-compared rather than as defects.
    const { SQL_COMPOSED_SUMMARY_FIELDS } = await import(
      "@/app/agent-sessions/service/usage-summary-sql"
    );
    const covered = [...SQL_COMPOSED_SUMMARY_FIELDS];
    const wideLive = Object.fromEntries(
      covered.map((field) => [field, 1])
    ) as unknown as AgentSessionUsageSummary;
    // Both sides are deliberately synthetic: the coverage set is numeric-only,
    // while a real summary also carries facet arrays this case has no use for.
    // `wideLive` has always been cast for that reason; typing the candidate mock
    // means `wideCandidate` needs the same one rather than an invented summary.
    const wideCandidate = Object.fromEntries(
      covered.map((field) => [field, 2])
    ) as unknown as AgentSessionUsageSummary;

    buildUsageSummaryFromSql.mockResolvedValue(wideCandidate);
    await shadowUsageSummary(input, wideLive);

    const [, payload] = info.mock.calls[0] as [string, Record<string, unknown>];
    // The COUNT stays whole; only the name list is bounded, so the cap is a
    // reporting limit rather than a measured one.
    expect(payload.defectCount).toBeGreaterThan(SHADOW_REPORTED_FIELD_CAP);
    expect(payload.defectFields).toHaveLength(SHADOW_REPORTED_FIELD_CAP);
  });
});

describe("shadowUsageSummary — prior-window handoff (ISS-10867)", () => {
  /**
   * `resolvePriorUsageWindow` reads `now()`, and this build starts strictly
   * after the live one already returned — so a fresh re-resolution here would
   * compare two independently-timed windows instead of the same window twice.
   * The fix hands the live-resolved window (already on the wire response)
   * to the candidate instead of letting it re-derive one.
   */
  it("passes the live-resolved prior window through, so both sides compare the same window", async () => {
    const liveWithComparison = {
      ...live,
      comparison: {
        priorStartDate: "2026-01-01T00:00:00.000Z",
        priorEndDate: "2026-01-08T00:00:00.000Z",
        deltas: {},
      },
    } as unknown as AgentSessionUsageSummary;
    buildUsageSummaryFromSql.mockResolvedValue(liveWithComparison);

    await shadowUsageSummary(input, liveWithComparison);

    expect(buildUsageSummaryFromSql).toHaveBeenCalledWith(input, {
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-08T00:00:00.000Z",
    });
  });

  /**
   * `null`, NOT `undefined`. Live carrying no comparison is an answer the
   * candidate must inherit, not a gap it should fill: `resolvePriorUsageWindow`
   * returns null while `now` is still before `startDate`, so on a range that
   * OPENS between the two builds an `undefined` here would let the candidate
   * resolve a window live never had, and the differ would report the whole
   * `comparison` field as a defect off the same clock race (whitlockk on #7751).
   */
  it("passes an explicit null when live carried no comparison to inherit a window from", async () => {
    buildUsageSummaryFromSql.mockResolvedValue(live);

    await shadowUsageSummary(input, live);

    expect(buildUsageSummaryFromSql).toHaveBeenCalledWith(input, null);
  });
});
