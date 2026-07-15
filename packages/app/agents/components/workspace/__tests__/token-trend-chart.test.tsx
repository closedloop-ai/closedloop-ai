import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TokenTrendChart, toChartData } from "../token-trend-chart";

// Mock the data hook so the chart can be exercised in isolation.
const mockUseTokenTrend = vi.fn();
vi.mock("../../../hooks/use-agent-component-token-trend", () => ({
  useAgentComponentTokenTrend: (slug: string) => mockUseTokenTrend(slug),
}));

const RE_EMPTY = /no token usage recorded/i;
const RE_ERROR = /failed to load token trend/i;

const twoModelResponse: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5", "claude-sonnet-4-5"],
  points: [
    {
      sessionId: "s1",
      sessionStartedAt: "2026-06-01T10:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.1,
      runtimeMs: 1000,
      componentInvocations: 1,
      componentErrorCount: 0,
    },
    {
      sessionId: "s2",
      sessionStartedAt: "2026-06-01T14:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.01,
      runtimeMs: 500,
      componentInvocations: 1,
      componentErrorCount: 0,
    },
    {
      sessionId: "s3",
      sessionStartedAt: "2026-06-02T09:00:00.000Z",
      model: "claude-sonnet-4-5",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.05,
      runtimeMs: 2000,
      componentInvocations: 2,
      componentErrorCount: 0,
    },
  ],
};

describe("toChartData", () => {
  it("returns empty series/points for undefined or empty responses", () => {
    expect(toChartData(undefined)).toEqual({ series: [], points: [] });
    expect(toChartData({ slug: "x", models: [], points: [] })).toEqual({
      series: [],
      points: [],
    });
  });

  it("maps models to series and buckets total tokens by day per model", () => {
    const { series, points } = toChartData(twoModelResponse);

    expect(series).toEqual([
      { key: "claude-opus-4-5", label: "claude-opus-4-5" },
      { key: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
    ]);

    // Two distinct days, sorted ascending.
    expect(points.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02"]);

    // Day 1: two opus points summed -> (100+50) + (10+5) = 165 total tokens.
    expect(points[0].values["claude-opus-4-5"]).toBe(165);
    // Day 2: one sonnet point -> 200+100 = 300.
    expect(points[1].values["claude-sonnet-4-5"]).toBe(300);
  });
});

describe("TokenTrendChart", () => {
  it("renders a skeleton while loading", () => {
    mockUseTokenTrend.mockReturnValue({ isLoading: true, isError: false });
    const { container } = render(<TokenTrendChart slug="skill::rtk" />);
    // Skeleton renders an animated placeholder div (no chart / no error text).
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders an error message on failure", () => {
    mockUseTokenTrend.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    });
    render(<TokenTrendChart slug="skill::rtk" />);
    expect(screen.getByText(RE_ERROR)).toBeInTheDocument();
  });

  it("renders the empty state when there are no points", () => {
    mockUseTokenTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { slug: "skill::rtk", models: [], points: [] },
    });
    render(<TokenTrendChart slug="skill::rtk" />);
    expect(screen.getByText(RE_EMPTY)).toBeInTheDocument();
  });

  it("renders the chart container when data is present", () => {
    mockUseTokenTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: twoModelResponse,
    });
    const { container } = render(<TokenTrendChart slug="skill::rtk" />);
    // Recharts mounts a chart wrapper; the empty/error copy must be absent.
    expect(screen.queryByText(RE_EMPTY)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_ERROR)).not.toBeInTheDocument();
    expect(
      container.querySelector(".recharts-responsive-container")
    ).not.toBeNull();
  });
});
