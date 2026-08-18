import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import type { TimeSeries } from "@repo/api/src/types/insights";
import { CHART_SERIES_COLOR_LIMIT } from "@repo/design-system/components/ui/chart-colors";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TokenTrendChart } from "../../../../agents/components/workspace/token-trend-chart";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../shared/feature-flags/static-feature-flag-adapter";
import { CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { ModelUsageChart } from "../model-usage-chart";

// ISS-5523 — the WIRING, not the fold. The sibling suites prove the chart caps
// and that the kernel's arithmetic is right; nothing there notices if a call
// site stops passing `maxSeries`. These drive the real product components
// through the real flag port, so deleting the prop at either call site turns
// this red rather than leaving the suite green with the bug back.
//
// The assertion is the aggregate band's own accessible name: it only exists when
// the flag reached `useChartMaxSeries`, which reached the chart, which folded.

const mockUseTokenTrend = vi.fn();
vi.mock("../../../../agents/hooks/use-agent-component-token-trend", () => ({
  useAgentComponentTokenTrend: (slug: string) => mockUseTokenTrend(slug),
}));

const MODEL_COUNT = CHART_SERIES_COLOR_LIMIT + 7;
const FOLDED_COUNT = MODEL_COUNT - CHART_SERIES_COLOR_LIMIT;
const AGGREGATE_NAME = `Other models (${FOLDED_COUNT})`;
const RE_ANY_AGGREGATE = /^Other/;

const modelKeys = Array.from(
  { length: MODEL_COUNT },
  (_unused, index) => `model-${index}`
);

const manyModelSeries: TimeSeries = {
  series: modelKeys.map((key) => ({ key, label: key })),
  points: ["2026-07-01", "2026-07-02"].map((date, dateIndex) => ({
    date,
    values: Object.fromEntries(
      modelKeys.map((key, index) => [
        key,
        (MODEL_COUNT - index) * (dateIndex + 2),
      ])
    ),
  })),
};

const manyModelTokenTrend: TokenTrendResponse = {
  slug: "skill::rtk",
  models: modelKeys,
  points: modelKeys.map((model, index) => ({
    sessionId: `s${index}`,
    sessionStartedAt: "2026-06-01T10:00:00.000Z",
    model,
    inputTokens: (MODEL_COUNT - index) * 100,
    outputTokens: (MODEL_COUNT - index) * 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: (MODEL_COUNT - index) * 0.1,
    runtimeMs: 1000,
    componentInvocations: 1,
    componentErrorCount: 0,
  })),
};

function renderWithFlag(node: ReactNode, enabled: boolean) {
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: enabled
      ? [CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY]
      : [],
  });
  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      {node}
    </FeatureFlagAdapterProvider>
  );
}

describe("ModelUsageChart series-cap wiring (ISS-5523)", () => {
  it("caps and names the aggregate band once the gate is open", () => {
    renderWithFlag(
      <ModelUsageChart series={manyModelSeries} tokenSeries={undefined} />,
      true
    );

    expect(
      screen.getByRole("button", { name: AGGREGATE_NAME })
    ).toBeInTheDocument();
  });

  it("draws every model, uncapped, while the gate is closed", () => {
    renderWithFlag(
      <ModelUsageChart series={manyModelSeries} tokenSeries={undefined} />,
      false
    );

    expect(screen.queryByText(RE_ANY_AGGREGATE)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: modelKeys.at(-1) as string })
    ).toBeInTheDocument();
  });
});

describe("chart series cap without a feature-flag provider (ISS-5523)", () => {
  it("stays uncapped rather than crashing the subtree", () => {
    // `useChartMaxSeries` reads the OPTIONAL flag hook precisely so a shared
    // chart mounted without the port (Storybook, a mini-table test) reads the
    // gate as closed instead of throwing. Rendering with no provider at all is
    // the only way to reach that branch.
    render(
      <ModelUsageChart series={manyModelSeries} tokenSeries={undefined} />
    );

    expect(screen.queryByText(RE_ANY_AGGREGATE)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: modelKeys.at(-1) as string })
    ).toBeInTheDocument();
  });
});

describe("TokenTrendChart series-cap wiring (ISS-5523)", () => {
  it("caps and names the aggregate band once the gate is open", () => {
    mockUseTokenTrend.mockReturnValue({
      data: manyModelTokenTrend,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithFlag(
      <TokenTrendChart
        sessions={MODEL_COUNT}
        slug="skill::rtk"
        usageSessions={[]}
        versions={[]}
      />,
      true
    );

    expect(
      screen.getByRole("button", { name: AGGREGATE_NAME })
    ).toBeInTheDocument();
  });

  it("draws every model, uncapped, while the gate is closed", () => {
    mockUseTokenTrend.mockReturnValue({
      data: manyModelTokenTrend,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithFlag(
      <TokenTrendChart
        sessions={MODEL_COUNT}
        slug="skill::rtk"
        usageSessions={[]}
        versions={[]}
      />,
      false
    );

    expect(screen.queryByText(RE_ANY_AGGREGATE)).not.toBeInTheDocument();
  });
});
