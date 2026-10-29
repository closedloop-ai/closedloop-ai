import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-8565 — the render tail of the token-trend fold.
 *
 * `time-series-area-chart.tsx` built its `config` and `colorByKey` maps on plain
 * `{}` and keyed them off `entry.key`, a wire-supplied model string. The two
 * maps failed differently, and this suite pins both:
 *
 * - `colorByKey`: the write was a silent no-op and the READ returned
 *   `Object.prototype`, so an OBJECT reached `fill`/`stroke` and the chart
 *   CRASHED. Reverting that container alone reds the first case.
 * - `config`: that series lost its label, so the legend went unnamed. Reverting
 *   that container alone reds the second case.
 *
 * JSDOM cannot lay Recharts out, but Recharts still emits one `.recharts-area`
 * per drawn `<Area>` and renders legend text, so both are readable without a
 * real paint.
 */
const SERIES: TimeSeriesSeriesDef[] = [
  { key: "__proto__", label: "Proto Model" },
  { key: "gpt-5-codex", label: "gpt-5-codex" },
];

const POINTS: TimeSeriesPointDatum[] = [
  // Built with a computed key: a quoted `"__proto__"` in an object LITERAL is
  // the prototype-setter form and would create no own key at all, so the
  // fixture itself would drop the series before the chart ever saw it.
  { date: "2026-06-01", values: { ["__proto__"]: 1500, "gpt-5-codex": 900 } },
  { date: "2026-06-02", values: { ["__proto__"]: 700, "gpt-5-codex": 400 } },
];

describe("TimeSeriesAreaChart: a series named __proto__ (ISS-8565)", () => {
  it("draws the __proto__ series instead of silently dropping it", () => {
    const { container } = render(
      <TimeSeriesAreaChart points={POINTS} series={SERIES} />
    );

    expect(container.querySelectorAll(".recharts-area")).toHaveLength(
      SERIES.length
    );
  });

  it("still names the __proto__ series in the legend", () => {
    const { container } = render(
      <TimeSeriesAreaChart points={POINTS} series={SERIES} />
    );

    // The LABEL is deliberately different from the KEY: the key reaches the DOM
    // by other routes, so asserting on it would pass even with `config` broken.
    // Only the config entry carries "Proto Model".
    expect(container.textContent).toContain("Proto Model");
  });

  it("draws every ordinary series unchanged", () => {
    const ordinary: TimeSeriesSeriesDef[] = [
      { key: "claude-opus-4-5", label: "claude-opus-4-5" },
      { key: "gpt-5-codex", label: "gpt-5-codex" },
    ];
    const { container } = render(
      <TimeSeriesAreaChart
        points={[
          {
            date: "2026-06-01",
            values: { "claude-opus-4-5": 10, "gpt-5-codex": 20 },
          },
        ]}
        series={ordinary}
      />
    );

    expect(container.querySelectorAll(".recharts-area")).toHaveLength(2);
  });
});
