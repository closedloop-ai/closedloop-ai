import type { TimeSeries } from "@repo/api/src/types/insights";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import goldenFixture from "../../../__tests__/fixtures/golden-render-aggregates.json";
import { AutonomyTrendChart } from "../autonomy-trend-chart";
import { ModelUsageChart } from "../model-usage-chart";

const DOLLAR_PREFIX_REGEX = /^\$/;
const NAN_REGEX = /NaN/;
const UNDEFINED_REGEX = /undefined/;
const COMPACT_1_5_REGEX = /1\.5/;

let lastTimeSeriesProps: {
  points?: unknown[];
  series?: unknown[];
  valueFormatter?: (value: number) => string;
  allowDecimals?: boolean;
  emptyMessage?: string;
} | null = null;

// Monotonic mount counter: each fresh mount of the mocked chart claims the next
// id via a mount-time ref. Reusing the SAME <AreaChart> instance across a
// re-render (the FEA-3623 bug) keeps the id stable; a key-driven remount bumps
// it. The test reads `data-mount-id` to prove the metric toggle remounts.
let nextChartMountId = 0;

vi.mock(
  "@repo/design-system/components/ui/time-series-area-chart",
  async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    return {
      TimeSeriesAreaChart: (props: {
        points: unknown[];
        series: Array<{ key: string; label: string }>;
        valueFormatter?: (value: number) => string;
        allowDecimals?: boolean;
        emptyMessage?: string;
      }) => {
        const mountId = React.useRef<number | null>(null);
        if (mountId.current === null) {
          mountId.current = nextChartMountId++;
        }
        lastTimeSeriesProps = props;
        return (
          <div
            data-mount-id={String(mountId.current)}
            data-testid="mock-time-series-area-chart"
          >
            {props.series.map((s) => (
              <span data-testid={`series-${s.key}`} key={s.key}>
                {s.label}
              </span>
            ))}
            {(
              props.points as Array<{
                date: string;
                values: Record<string, number | null>;
              }>
            ).map((p) => (
              <div data-testid={`point-${p.date}`} key={p.date}>
                {Object.entries(p.values).map(([k, v]) => (
                  <span
                    data-testid={`val-${p.date}-${k}`}
                    data-value={String(v)}
                    key={k}
                  >
                    {k}={v}
                  </span>
                ))}
              </div>
            ))}
          </div>
        );
      },
    };
  }
);

vi.mock("@repo/design-system/components/ui/skeleton", () => ({
  Skeleton: (props: { className?: string }) => (
    <div
      className={props.className}
      data-slot="skeleton"
      data-testid="skeleton"
    />
  ),
}));

// The chart now renders TWO toggle groups (metric $/# and grouping model/provider).
// Route each item's click to its OWN group's onValueChange via context so the two
// groups don't clobber a single shared handler.
vi.mock("@repo/design-system/components/ui/toggle-group", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const HandlerContext = React.createContext<(v: string) => void>(() => {
    // no-op default
  });
  return {
    ToggleGroup: ({
      children,
      value,
      onValueChange,
      "aria-label": ariaLabel,
    }: {
      children: React.ReactNode;
      onValueChange: (v: string) => void;
      value: string;
      type?: string;
      variant?: string;
      "aria-label"?: string;
    }) =>
      React.createElement(
        HandlerContext.Provider,
        { value: onValueChange },
        React.createElement(
          "div",
          {
            "data-testid": "toggle-group",
            "data-value": value,
            "data-label": ariaLabel,
          },
          children
        )
      ),
    ToggleGroupItem: ({
      children,
      value,
      "aria-label": ariaLabel,
    }: {
      children: React.ReactNode;
      value: string;
      "aria-label"?: string;
    }) => {
      const onValueChange = React.useContext(HandlerContext);
      return React.createElement(
        "button",
        {
          "aria-label": ariaLabel,
          "data-testid": `toggle-${value}`,
          onClick: () => onValueChange(value),
          type: "button",
        },
        children
      );
    },
  };
});

const goldenAutonomyTrend = goldenFixture.sections.agents.charts
  .autonomyTrend as TimeSeries;
const goldenModelUsage = goldenFixture.sections.agents.charts
  .modelUsageOverTime as TimeSeries;

describe("AutonomyTrendChart / ModelUsageChart render contracts", () => {
  // ---------------------------------------------------------------------------
  // FEA-3238: fully-manual day (autonomy=0) is distinct from no-activity (null)
  // ---------------------------------------------------------------------------
  it("FEA-3238: fully-manual day renders 0, no-activity day renders null", () => {
    const series: TimeSeries = {
      series: [{ key: "autonomy", label: "Autonomy" }],
      points: [
        { date: "2026-07-01", values: { autonomy: 0 } },
        { date: "2026-07-02", values: { autonomy: null } },
      ],
    };

    render(<AutonomyTrendChart series={series} />);

    const point1 = screen.getByTestId("val-2026-07-01-autonomy");
    const point2 = screen.getByTestId("val-2026-07-02-autonomy");
    expect(point1.getAttribute("data-value")).toBe("0");
    expect(point2.getAttribute("data-value")).toBe("null");
    expect(point1.getAttribute("data-value")).not.toBe(
      point2.getAttribute("data-value")
    );
  });

  // ---------------------------------------------------------------------------
  // undefined → skeleton vs data → chart
  // ---------------------------------------------------------------------------
  describe("AutonomyTrendChart skeleton vs chart", () => {
    it("renders skeleton when series is undefined", () => {
      render(<AutonomyTrendChart series={undefined} />);

      expect(screen.getByTestId("skeleton")).toBeInTheDocument();
      expect(
        screen.queryByTestId("mock-time-series-area-chart")
      ).not.toBeInTheDocument();
    });

    it("renders chart (not skeleton) when series has all-zero values", () => {
      const allZero: TimeSeries = {
        series: [{ key: "autonomy", label: "Autonomy" }],
        points: [
          { date: "2026-07-01", values: { autonomy: 0 } },
          { date: "2026-07-02", values: { autonomy: 0 } },
        ],
      };

      render(<AutonomyTrendChart series={allZero} />);

      expect(
        screen.getByTestId("mock-time-series-area-chart")
      ).toBeInTheDocument();
      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
    });
  });

  describe("ModelUsageChart skeleton vs chart", () => {
    it("renders skeleton when series is undefined", () => {
      render(<ModelUsageChart series={undefined} />);

      expect(screen.getByTestId("skeleton")).toBeInTheDocument();
      expect(
        screen.queryByTestId("mock-time-series-area-chart")
      ).not.toBeInTheDocument();
    });

    it("renders chart (not skeleton) when series has all-zero values", () => {
      const allZero: TimeSeries = {
        series: [{ key: "claude-sonnet-4-6", label: "claude-sonnet-4-6" }],
        points: [{ date: "2026-07-01", values: { "claude-sonnet-4-6": 0 } }],
      };

      render(<ModelUsageChart series={allZero} />);

      expect(
        screen.getByTestId("mock-time-series-area-chart")
      ).toBeInTheDocument();
      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // providerOf regroup
  //
  // providerOf matching rules (from model-usage-chart.tsx):
  //   - includes("claude")         → Anthropic
  //   - includes("gpt") | includes("codex") | startsWith("o1") | startsWith("o3") → OpenAI
  //   - includes("gemini")         → Google
  //   - everything else            → Other
  //
  // groupByProvider sums model values per provider per point.
  // ---------------------------------------------------------------------------
  describe("providerOf regroup", () => {
    const series: TimeSeries = {
      series: [
        { key: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
        { key: "gpt-5", label: "gpt-5" },
        { key: "gemini-2.5-pro", label: "gemini-2.5-pro" },
        { key: "mystery-model", label: "mystery-model" },
      ],
      points: [
        {
          date: "2026-07-01",
          values: {
            "claude-sonnet-4-5": 10,
            "gpt-5": 20,
            "gemini-2.5-pro": 30,
            "mystery-model": 5,
          },
        },
        {
          date: "2026-07-02",
          values: {
            "claude-sonnet-4-5": 7,
            "gpt-5": 3,
            "gemini-2.5-pro": 0,
            "mystery-model": 11,
          },
        },
      ],
    };

    it("default model mode passes through per-model series unchanged", () => {
      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={series} />);

      expect(
        screen.getByTestId("series-claude-sonnet-4-5")
      ).toBeInTheDocument();
      expect(screen.getByTestId("series-gpt-5")).toBeInTheDocument();
      expect(screen.getByTestId("series-gemini-2.5-pro")).toBeInTheDocument();
      expect(screen.getByTestId("series-mystery-model")).toBeInTheDocument();

      expect(
        screen.getByTestId("val-2026-07-01-claude-sonnet-4-5")
      ).toHaveAttribute("data-value", "10");
      expect(screen.getByTestId("val-2026-07-01-gpt-5")).toHaveAttribute(
        "data-value",
        "20"
      );
      expect(
        screen.getByTestId("val-2026-07-01-gemini-2.5-pro")
      ).toHaveAttribute("data-value", "30");
      expect(
        screen.getByTestId("val-2026-07-01-mystery-model")
      ).toHaveAttribute("data-value", "5");
    });

    it("groups models into Anthropic/OpenAI/Google/Other and sums per-provider values", () => {
      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={series} />);

      act(() => {
        screen.getByTestId("toggle-provider").click();
      });

      const providerSeries = lastTimeSeriesProps!.series as Array<{
        key: string;
        label: string;
      }>;
      const providerKeys = providerSeries.map((s) => s.key).sort();
      expect(providerKeys).toEqual(
        ["Anthropic", "Google", "OpenAI", "Other"].sort()
      );

      expect(screen.queryByTestId("series-claude-sonnet-4-5")).toBeNull();
      expect(screen.queryByTestId("series-gpt-5")).toBeNull();
      expect(screen.getByTestId("series-Anthropic")).toBeInTheDocument();
      expect(screen.getByTestId("series-OpenAI")).toBeInTheDocument();
      expect(screen.getByTestId("series-Google")).toBeInTheDocument();
      expect(screen.getByTestId("series-Other")).toBeInTheDocument();

      expect(screen.getByTestId("val-2026-07-01-Anthropic")).toHaveAttribute(
        "data-value",
        "10"
      );
      expect(screen.getByTestId("val-2026-07-01-OpenAI")).toHaveAttribute(
        "data-value",
        "20"
      );
      expect(screen.getByTestId("val-2026-07-01-Google")).toHaveAttribute(
        "data-value",
        "30"
      );
      expect(screen.getByTestId("val-2026-07-01-Other")).toHaveAttribute(
        "data-value",
        "5"
      );

      expect(screen.getByTestId("val-2026-07-02-Anthropic")).toHaveAttribute(
        "data-value",
        "7"
      );
      expect(screen.getByTestId("val-2026-07-02-OpenAI")).toHaveAttribute(
        "data-value",
        "3"
      );
      expect(screen.getByTestId("val-2026-07-02-Google")).toHaveAttribute(
        "data-value",
        "0"
      );
      expect(screen.getByTestId("val-2026-07-02-Other")).toHaveAttribute(
        "data-value",
        "11"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // providerOf — unit-level matching rules
  // ---------------------------------------------------------------------------
  describe("providerOf matching rules (exercised through provider-mode render)", () => {
    it("maps codex models to OpenAI", () => {
      const series: TimeSeries = {
        series: [{ key: "codex-mini-latest", label: "codex-mini-latest" }],
        points: [{ date: "2026-07-01", values: { "codex-mini-latest": 15 } }],
      };

      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={series} />);

      act(() => {
        screen.getByTestId("toggle-provider").click();
      });

      expect(screen.getByTestId("series-OpenAI")).toBeInTheDocument();
      expect(screen.queryByTestId("series-codex-mini-latest")).toBeNull();
      expect(screen.getByTestId("val-2026-07-01-OpenAI")).toHaveAttribute(
        "data-value",
        "15"
      );
    });

    it("maps o1/o3 prefixed models to OpenAI", () => {
      const series: TimeSeries = {
        series: [
          { key: "o1-preview", label: "o1-preview" },
          { key: "o3-mini", label: "o3-mini" },
        ],
        points: [
          { date: "2026-07-01", values: { "o1-preview": 5, "o3-mini": 8 } },
        ],
      };

      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={series} />);

      act(() => {
        screen.getByTestId("toggle-provider").click();
      });

      expect(screen.getByTestId("series-OpenAI")).toBeInTheDocument();
      expect(screen.queryByTestId("series-o1-preview")).toBeNull();
      expect(screen.queryByTestId("series-o3-mini")).toBeNull();
      expect(screen.getByTestId("val-2026-07-01-OpenAI")).toHaveAttribute(
        "data-value",
        "13"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Currency wiring
  // ---------------------------------------------------------------------------
  it("passes a currency formatter ($ prefix) to the chart", () => {
    const series: TimeSeries = {
      series: [{ key: "claude-opus-4-8", label: "claude-opus-4-8" }],
      points: [{ date: "2026-07-01", values: { "claude-opus-4-8": 42.5 } }],
    };

    lastTimeSeriesProps = null;
    render(<ModelUsageChart series={series} />);

    expect(lastTimeSeriesProps).not.toBeNull();
    const formatter = lastTimeSeriesProps!.valueFormatter;
    expect(formatter).toBeDefined();
    expect(formatter!(42.5)).toMatch(DOLLAR_PREFIX_REGEX);
    expect(formatter!(5.25)).toBe("$5.25");
    expect(formatter!(1500)).toMatch(DOLLAR_PREFIX_REGEX);
  });

  // ---------------------------------------------------------------------------
  // FEA-3497: $ / # metric toggle
  // ---------------------------------------------------------------------------
  describe("metric toggle ($ spend vs # tokens)", () => {
    const spend: TimeSeries = {
      series: [{ key: "claude-opus-4-8", label: "claude-opus-4-8" }],
      points: [{ date: "2026-07-01", values: { "claude-opus-4-8": 1.5 } }],
    };
    const tokens: TimeSeries = {
      series: [{ key: "claude-opus-4-8", label: "claude-opus-4-8" }],
      points: [
        { date: "2026-07-01", values: { "claude-opus-4-8": 1_500_000 } },
      ],
    };

    it("defaults to spend: dollar title, dollar formatter, spend values", () => {
      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={spend} tokenSeries={tokens} />);

      expect(screen.getByText("Model cost over time")).toBeInTheDocument();
      expect(
        screen.getByTestId("val-2026-07-01-claude-opus-4-8")
      ).toHaveAttribute("data-value", "1.5");
      expect(lastTimeSeriesProps!.allowDecimals).toBe(true);
      expect(lastTimeSeriesProps!.valueFormatter!(1.5)).toBe("$1.50");
    });

    it("switches to tokens: usage title, compact (non-$) formatter, token values", () => {
      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={spend} tokenSeries={tokens} />);

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });

      expect(screen.getByText("Model usage over time")).toBeInTheDocument();
      expect(
        screen.getByTestId("val-2026-07-01-claude-opus-4-8")
      ).toHaveAttribute("data-value", "1500000");
      // Token counts are whole integers → no fractional ticks, no "$" prefix.
      expect(lastTimeSeriesProps!.allowDecimals).toBe(false);
      const formatted = lastTimeSeriesProps!.valueFormatter!(1_500_000);
      expect(formatted).not.toMatch(DOLLAR_PREFIX_REGEX);
      expect(formatted).toMatch(COMPACT_1_5_REGEX);
    });

    it("remounts the chart when the metric flips so the plot re-renders (FEA-3623)", () => {
      // Regression: spend and token series share the same model keys/colors, so
      // without a metric-scoped key React reconciles the same <AreaChart> in
      // place and Recharts keeps its cached scale/paths — the plot stays on the
      // old metric even though `points` changed. A fresh mount id proves the
      // chart actually remounted (and thus re-rendered) on toggle.
      render(<ModelUsageChart series={spend} tokenSeries={tokens} />);

      const spendMountId = screen
        .getByTestId("mock-time-series-area-chart")
        .getAttribute("data-mount-id");

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });
      const tokensMountId = screen
        .getByTestId("mock-time-series-area-chart")
        .getAttribute("data-mount-id");

      act(() => {
        screen.getByTestId("toggle-cost").click();
      });
      const backToSpendMountId = screen
        .getByTestId("mock-time-series-area-chart")
        .getAttribute("data-mount-id");

      expect(spendMountId).not.toBeNull();
      // Each metric flip yields a distinct chart instance (not an in-place
      // reconcile of the stale one).
      expect(tokensMountId).not.toBe(spendMountId);
      expect(backToSpendMountId).not.toBe(tokensMountId);
    });

    it("grouping applies under the token metric", () => {
      const multi: TimeSeries = {
        series: [
          { key: "claude-opus-4-8", label: "claude-opus-4-8" },
          { key: "gpt-5", label: "gpt-5" },
        ],
        points: [
          {
            date: "2026-07-01",
            values: { "claude-opus-4-8": 100, "gpt-5": 40 },
          },
        ],
      };
      render(<ModelUsageChart series={spend} tokenSeries={multi} />);

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });
      act(() => {
        screen.getByTestId("toggle-provider").click();
      });

      expect(screen.getByTestId("val-2026-07-01-Anthropic")).toHaveAttribute(
        "data-value",
        "100"
      );
      expect(screen.getByTestId("val-2026-07-01-OpenAI")).toHaveAttribute(
        "data-value",
        "40"
      );
    });

    // FEA-3699: an absent optional token series is a *completed* result once
    // spend has loaded, not a permanent loading state. The # view must resolve
    // to the chart's own empty-state (never a stuck skeleton), and it must NOT
    // borrow the spend series (different quantity — that would be a lying UI).
    it("resolves the # view to an unavailable empty-state (not skeleton) when the token series is absent", () => {
      lastTimeSeriesProps = null;
      render(<ModelUsageChart series={spend} tokenSeries={undefined} />);

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });

      // Not stuck on the skeleton...
      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
      // ...the chart renders its empty-state (no series/points)...
      expect(
        screen.getByTestId("mock-time-series-area-chart")
      ).toBeInTheDocument();
      expect(lastTimeSeriesProps).not.toBeNull();
      expect(lastTimeSeriesProps!.series).toEqual([]);
      expect(lastTimeSeriesProps!.points).toEqual([]);
      // ...with explicit "unavailable" copy, distinct from "no usage in range".
      expect(lastTimeSeriesProps!.emptyMessage).toBe(
        "Token usage wasn't recorded for this range"
      );
      // ...and it must not leak the spend series' 1.5 value into the # view.
      expect(screen.queryByTestId("val-2026-07-01-claude-opus-4-8")).toBeNull();
    });

    it("keeps the skeleton on the # view only while the whole card is still loading (spend absent too)", () => {
      render(<ModelUsageChart series={undefined} tokenSeries={undefined} />);

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });

      expect(screen.getByTestId("skeleton")).toBeInTheDocument();
      expect(
        screen.queryByTestId("mock-time-series-area-chart")
      ).not.toBeInTheDocument();
    });

    it("toggling # → $ → # never re-enters a permanent loading skeleton when tokens are absent", () => {
      render(<ModelUsageChart series={spend} tokenSeries={undefined} />);

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });
      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();

      act(() => {
        screen.getByTestId("toggle-cost").click();
      });
      // Spend view: real chart, no skeleton.
      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("val-2026-07-01-claude-opus-4-8")
      ).toHaveAttribute("data-value", "1.5");

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });
      // Back on tokens: still the empty-state, still not a skeleton.
      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("mock-time-series-area-chart")
      ).toBeInTheDocument();
    });

    it("renders an empty (defined) token series as the chart's no-data empty-state, not the unavailable copy", () => {
      lastTimeSeriesProps = null;
      const emptyTokens: TimeSeries = { series: [], points: [] };
      render(<ModelUsageChart series={spend} tokenSeries={emptyTokens} />);

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });

      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
      // A measured-but-empty series is "no usage in range", NOT "unavailable".
      expect(lastTimeSeriesProps!.emptyMessage).toBe(
        "No model usage in range yet"
      );
    });

    it("renders an all-zero token series without NaN/undefined and without a skeleton", () => {
      const zeroTokens: TimeSeries = {
        series: [{ key: "claude-opus-4-8", label: "claude-opus-4-8" }],
        points: [{ date: "2026-07-01", values: { "claude-opus-4-8": 0 } }],
      };
      const { container } = render(
        <ModelUsageChart series={spend} tokenSeries={zeroTokens} />
      );

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });

      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("val-2026-07-01-claude-opus-4-8")
      ).toHaveAttribute("data-value", "0");
      expect(container.innerHTML).not.toMatch(NAN_REGEX);
      expect(container.innerHTML).not.toMatch(UNDEFINED_REGEX);
    });

    // NOTE: the chart is mocked here, so this test does NOT exercise the real
    // missing-key→0 defaulting (that lives in time-series-area-chart.tsx and is
    // covered by the companion test below). What it verifies is narrower but
    // still worth pinning: ModelUsageChart's OWN passthrough of a malformed
    // token series (a series key declared but absent from a bucket) does not
    // inject NaN/undefined into its output and keeps the present value intact.
    it("passes a malformed token series (missing per-bucket keys) through without NaN/undefined", () => {
      const malformed: TimeSeries = {
        series: [
          { key: "claude-opus-4-8", label: "claude-opus-4-8" },
          { key: "gpt-5", label: "gpt-5" },
        ],
        // gpt-5 declared as a series but absent from the bucket values.
        points: [{ date: "2026-07-01", values: { "claude-opus-4-8": 10 } }],
      };
      const { container } = render(
        <ModelUsageChart series={spend} tokenSeries={malformed} />
      );

      act(() => {
        screen.getByTestId("toggle-tokens").click();
      });

      expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("val-2026-07-01-claude-opus-4-8")
      ).toHaveAttribute("data-value", "10");
      expect(container.innerHTML).not.toMatch(NAN_REGEX);
      expect(container.innerHTML).not.toMatch(UNDEFINED_REGEX);
    });
  });

  // ---------------------------------------------------------------------------
  // Golden fixture sanity
  // ---------------------------------------------------------------------------
  describe("golden fixture sanity", () => {
    it("AutonomyTrendChart renders golden autonomyTrend without NaN or undefined in DOM", () => {
      const { container } = render(
        <AutonomyTrendChart series={goldenAutonomyTrend} />
      );

      expect(
        screen.getByTestId("mock-time-series-area-chart")
      ).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(NAN_REGEX);
      expect(container.innerHTML).not.toMatch(UNDEFINED_REGEX);
    });

    it("ModelUsageChart renders golden modelUsageOverTime without NaN or undefined in DOM", () => {
      const { container } = render(
        <ModelUsageChart series={goldenModelUsage} />
      );

      expect(
        screen.getByTestId("mock-time-series-area-chart")
      ).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(NAN_REGEX);
      expect(container.innerHTML).not.toMatch(UNDEFINED_REGEX);
    });
  });
});
