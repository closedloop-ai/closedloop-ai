import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsInOrganization: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  isMember: vi.fn(),
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    existsInOrganization: mocks.existsInOrganization,
    isMember: mocks.isMember,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn(async () => undefined),
    info: mocks.logInfo,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

import { ORG_ADMIN_STATUS_NOT_ADMIN } from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import {
  INSIGHTS_SECTION_LATENCY_WINDOW_MS,
  insightsSectionLatencyThrottle,
} from "@/lib/observability/insights-section-latency-throttle";
import { createInsightsHandler } from "./route-handler";
import {
  identity,
  metricPayloads,
  request,
  TEAM_ID,
  USER,
} from "./route-handler-test-fixtures";

/**
 * How many times the emission-bound tests replay one identical section read.
 * Any value above 1 proves the bound; 5 keeps the suppressed-count assertion
 * (`REPLAY_COUNT - 1`) a number a reader can check by hand.
 */
const REPLAY_COUNT = 5;

/**
 * ISS-7512 — `insights.dashboard.section_latency`.
 *
 * Asserted through `log.info`, the real emit sink, rather than by mocking
 * `emitInsightsSectionLatency`: the deliverable is a payload a Datadog
 * log-to-metric rule can match on `@_telemetryMetric:true @metric:… @origin:api`,
 * and a mock of our own emitter would stay green if the marker, the metric name
 * or the origin were dropped — the three fields the pipeline actually filters on.
 */
describe("createInsightsHandler section latency metric", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The emission throttle is a process-local singleton, so without this a key
    // spent by one test would suppress the next one's sample.
    insightsSectionLatencyThrottle.clear();
    mocks.existsInOrganization.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it("emits one bounded-cardinality sample on a successful section read", async () => {
    const handler = createInsightsHandler({
      fetch: vi.fn().mockResolvedValue({ kpis: [], charts: {} }),
      section: InsightsSection.Utilization,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      identity(),
      request(
        `/insights/utilization?period=${InsightsPeriod.Month}&scope=${InsightsScope.Org}`
      )
    );

    expect(response.status).toBe(200);
    const samples = latencySamples();
    expect(samples).toHaveLength(1);
    const [sample] = samples;
    // deepEqual over everything EXCEPT the duration: an added field is how a
    // raw org/user/team id would reach the metric, and a subset assertion
    // cannot see one arrive.
    const { value, ...tags } = sample;
    expect(tags).toEqual({
      _telemetryMetric: true,
      metric: FilterToken.InsightsDashboardSectionLatency,
      // The ticket's triage query is `@origin:api`; `apps/api/__tests__/setup.ts`
      // pins DD_SERVICE=api for this lane, so this is the real resolved origin
      // and not an artifact of an unset env (which would read "unknown").
      origin: "api",
      section: InsightsSection.Utilization,
      period: InsightsPeriod.Month,
      scope: InsightsScope.Org,
      teamScoped: false,
    });
    expect(typeof value).toBe("number");
  });

  it("reports a team read as team-scoped without naming the team", async () => {
    const handler = createInsightsHandler({
      fetch: vi.fn().mockResolvedValue({ kpis: [], charts: {} }),
      section: InsightsSection.Agents,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      identity(),
      request(
        `/insights/agents?period=${InsightsPeriod.Week}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`
      )
    );

    expect(response.status).toBe(200);
    const [sample] = latencySamples();
    // The positive half of the `teamScoped: false` assertion above — without a
    // case that makes it true, a hardcoded `false` would satisfy both.
    expect(sample.teamScoped).toBe(true);
    expect(sample.scope).toBe(InsightsScope.Team);
    expect(JSON.stringify(sample)).not.toContain(TEAM_ID);
    expect(JSON.stringify(sample)).not.toContain(USER.organizationId);
    expect(JSON.stringify(sample)).not.toContain(USER.id);
  });

  it.each([
    [
      "team scope arrives without a teamId",
      () => undefined,
      `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}`,
      400,
    ],
    [
      "the period is not a known window",
      () => undefined,
      "/insights/delivery?period=nonsense",
      400,
    ],
    [
      "the caller may not read the requested team",
      () => mocks.isMember.mockResolvedValue(false),
      `/insights/delivery?period=${InsightsPeriod.Quarter}&scope=${InsightsScope.Team}&teamId=${TEAM_ID}`,
      403,
    ],
  ])(
    "emits nothing when %s, because no section read started",
    async (_name, arrange, path, expectedStatus) => {
      arrange();
      const fetch = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
      const handler = createInsightsHandler({
        fetch,
        section: InsightsSection.Delivery,
        errorMessage: "Failed to load insights",
      });

      const response = await handler(identity(), request(path));

      expect(response.status).toBe(expectedStatus);
      expect(fetch).not.toHaveBeenCalled();
      // A `0` here would read in Datadog as the fastest possible delivery read
      // and drag the p50 of every dashboard-latency panel toward zero.
      expect(latencySamples()).toEqual([]);
    }
  );

  it("emits nothing when the section itself fails, and still logs the failure", async () => {
    const handler = createInsightsHandler({
      fetch: vi.fn().mockRejectedValue(new Error("boom")),
      section: InsightsSection.Delivery,
      errorMessage: "Failed to load insights",
    });

    const response = await handler(
      identity(),
      request(`/insights/delivery?period=${InsightsPeriod.Quarter}`)
    );

    expect(response.status).toBe(500);
    expect(latencySamples()).toEqual([]);
    // The existing correlation must survive the change — a latency metric that
    // replaced the failure log would cost the operator the org/user pivot.
    expect(mocks.logError).toHaveBeenCalledWith(
      "insights.delivery_failed",
      expect.objectContaining({ organizationId: USER.organizationId })
    );
  });

  /**
   * #5818 review (whitlockk) — the emit is bounded at the choke point.
   *
   * `/insights/*` has no rate limiter in front of it, so before this an
   * authenticated caller could replay one section route into an unbounded emit
   * stream. These drive the REAL handler repeatedly and count what reached the
   * sink; a test that asserted the throttle was merely consulted would stay
   * green if the handler ignored its answer.
   */
  it("emits one sample however many times the same read is replayed", async () => {
    const handler = createInsightsHandler({
      fetch: vi.fn().mockResolvedValue({ kpis: [], charts: {} }),
      section: InsightsSection.Utilization,
      errorMessage: "Failed to load insights",
    });
    const path = `/insights/utilization?period=${InsightsPeriod.Month}&scope=${InsightsScope.Org}`;

    for (let attempt = 0; attempt < REPLAY_COUNT; attempt += 1) {
      const response = await handler(identity(), request(path));
      expect(response.status).toBe(200);
    }

    // The bound itself. Unthrottled this is REPLAY_COUNT.
    expect(latencySamples()).toHaveLength(1);
  });

  it("rolls the suppressed reads up rather than losing them", async () => {
    const handler = createInsightsHandler({
      fetch: vi.fn().mockResolvedValue({ kpis: [], charts: {} }),
      section: InsightsSection.Utilization,
      errorMessage: "Failed to load insights",
    });
    const path = `/insights/utilization?period=${InsightsPeriod.Month}&scope=${InsightsScope.Org}`;

    for (let attempt = 0; attempt < REPLAY_COUNT; attempt += 1) {
      await handler(identity(), request(path));
    }
    // Nothing is owed while the window is still open — the count is pending in
    // memory, not lost.
    expect(suppressedRollups()).toEqual([]);

    // Close the window by moving the clock past it, then read once more: the
    // rollover is what materialises the rollup. Restored immediately — a leaked
    // `Date.now` would survive `clearAllMocks`, which resets calls but not
    // implementations.
    const afterWindow = Date.now() + INSIGHTS_SECTION_LATENCY_WINDOW_MS + 1;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(afterWindow);
    await handler(identity(), request(path));
    nowSpy.mockRestore();

    const rollups = suppressedRollups();
    expect(rollups).toHaveLength(1);
    const [rollup] = rollups;
    // Every read after the one that was sampled, and no tenant id on the way out.
    expect(rollup.count).toBe(REPLAY_COUNT - 1);
    expect(rollup.section).toBe(InsightsSection.Utilization);
    expect(rollup.period).toBe(InsightsPeriod.Month);
    expect(rollup.scope).toBe(InsightsScope.Org);
    expect(JSON.stringify(rollup)).not.toContain(USER.organizationId);
  });

  it("does not let one tag tuple silence another", async () => {
    const handler = createInsightsHandler({
      fetch: vi.fn().mockResolvedValue({ kpis: [], charts: {} }),
      section: InsightsSection.Utilization,
      errorMessage: "Failed to load insights",
    });

    await handler(
      identity(),
      request(
        `/insights/utilization?period=${InsightsPeriod.Month}&scope=${InsightsScope.Org}`
      )
    );
    await handler(
      identity(),
      request(
        `/insights/utilization?period=${InsightsPeriod.All}&scope=${InsightsScope.Org}`
      )
    );

    // A section-only throttle key would drop the second: a slow `period=all`
    // read silenced by a fast `period=30` one would leave the panel reporting a
    // latency profile no reader experienced.
    expect(latencySamples().map((sample) => sample.period)).toEqual([
      InsightsPeriod.Month,
      InsightsPeriod.All,
    ]);
  });
});

/** Every section-latency payload `log.info` received, parsed back from JSON. */
function latencySamples(): Record<string, unknown>[] {
  return metricPayloads(
    mocks.logInfo.mock.calls,
    FilterToken.InsightsDashboardSectionLatency
  );
}

/** Every suppressed-count rollup `log.info` received, parsed back from JSON. */
function suppressedRollups(): Record<string, unknown>[] {
  return metricPayloads(
    mocks.logInfo.mock.calls,
    FilterToken.InsightsDashboardSectionLatencySuppressed
  );
}
