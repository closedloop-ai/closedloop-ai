/**
 * ISS-7512 — `insights.dashboard.section_latency` emitter.
 *
 * The wiring (which requests emit, and which must not) is proven through the
 * production handler in `app/insights/lib/route-handler.test.ts`. What only this
 * file can reach is the best-effort contract: the emit sink throwing must not
 * propagate into a response whose section data already resolved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogInfo } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitInsightsSectionLatency } from "@/lib/observability/insights-metrics";

const SAMPLE = {
  section: InsightsSection.Delivery,
  period: InsightsPeriod.All,
  scope: InsightsScope.Me,
  teamScoped: false,
  durationMs: 1234,
} as const;

describe("emitInsightsSectionLatency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits under the exact metric name the Datadog pipeline filters on", () => {
    // The one place the literal is written out. Everywhere else — including the
    // sample filter in `route-handler.test.ts` — goes through the FilterToken
    // symbol, so a rename cannot make an assertion silently match nothing. But
    // a symbol compared against itself pins no VALUE, and this value is a
    // cross-repo contract: the `datadog_logs_metric` rule in example-infrastructure
    // matches on it, so a rename here needs a paired PR there. This assertion
    // is what makes that rename visible instead of quietly green.
    expect(FilterToken.InsightsDashboardSectionLatency).toBe(
      "insights.dashboard.section_latency"
    );
  });

  it("writes the duration as a gauge under the pipeline's filter marker", () => {
    emitInsightsSectionLatency(SAMPLE);

    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockLogInfo.mock.calls[0][0] as string)).toEqual({
      _telemetryMetric: true,
      metric: FilterToken.InsightsDashboardSectionLatency,
      origin: "api",
      section: InsightsSection.Delivery,
      period: InsightsPeriod.All,
      scope: InsightsScope.Me,
      teamScoped: false,
      // `value:`, never `count:` — a duration summed across a window is not a
      // latency. See "Metric field semantics" in packages/observability/README.md.
      value: 1234,
    });
  });

  it("swallows a failing sink so telemetry cannot 500 a resolved section", () => {
    mockLogInfo.mockImplementation(() => {
      throw new Error("drain unavailable");
    });

    expect(() => emitInsightsSectionLatency(SAMPLE)).not.toThrow();
    // The positive half: the sink really was reached, so the no-throw above is
    // the catch doing its job rather than the emit being skipped entirely.
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
  });
});
