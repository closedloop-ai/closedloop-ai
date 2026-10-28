/**
 * ISS-9842: the cataloged `DonutChart` (`components/ui/donut-chart.tsx`, NOT the
 * deprecated `primitives/donut-chart.tsx`) drawn against a POPULATION its
 * `data` is only a prefix of.
 *
 * Recharts' SVG layout does not measure inside jsdom, so the chart primitives
 * are stubbed the same way `packages/app`'s share-legend suite stubs them.
 * Everything under test stays real: the residual slice, the denominator the
 * shares are allocated over, the key and colour resolution, the `ChartContainer`
 * config, and the real `ChartLegendContent` that reads labels out of it.
 */

import { CHART_OTHER_SERIES_COLOR } from "@closedloop-ai/design-system/components/ui/chart-colors";
import {
  CHART_OTHER_SERIES_KEY,
  CHART_OTHER_SERIES_LABEL,
} from "@closedloop-ai/design-system/components/ui/chart-series-fold";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Slice = { key: string; label: string; value: number };

// Top-level per Ultracite's useTopLevelRegex.
const SHARE_SUFFIX = /(\d+)%$/;
const OTHER_LABEL = /^Other/;
const startsWithDefaultOtherLabel = (content: string) =>
  content.startsWith(CHART_OTHER_SERIES_LABEL);

const captured = vi.hoisted(() => ({ data: [] as Slice[] }));

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PieChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Pie: ({ children, data }: { children: ReactNode; data: Slice[] }) => {
      captured.data = data;
      return <div>{children}</div>;
    },
    Cell: ({ fill }: { fill: string }) => (
      <div data-fill={fill} data-testid="slice" />
    ),
    Legend: ({ content }: { content: ReactElement }) =>
      isValidElement(content)
        ? cloneElement(content, {
            payload: captured.data.map((slice) => ({
              value: slice.key,
              dataKey: slice.key,
              color: "var(--chart-1)",
              payload: slice,
            })),
          } as Record<string, unknown>)
        : null,
  };
});

const { DonutChart } = await import(
  "@closedloop-ai/design-system/components/ui/donut-chart"
);

// Four of nine tools, 70 of 100 runs: the five omitted tools hold 30 runs.
const PREFIX: Slice[] = [
  { key: "Bash", label: "Bash", value: 30 },
  { key: "Read", label: "Read", value: 20 },
  { key: "Edit", label: "Edit", value: 12 },
  { key: "Grep", label: "Grep", value: 8 },
];
const PREFIX_SUM = 70;
const POPULATION_TOTAL = 100;
const OMITTED = 5;

function sliceFills(): (string | null)[] {
  return screen
    .getAllByTestId("slice")
    .map((node) => node.getAttribute("data-fill"));
}

function printedShares(): number[] {
  return screen
    .getAllByText(SHARE_SUFFIX)
    .map((node) => Number(node.textContent?.match(SHARE_SUFFIX)?.[1] ?? 0));
}

afterEach(cleanup);

describe("DonutChart residual wedge (ISS-9842)", () => {
  it("draws the remainder as a count-carrying Other slice and allocates shares over the population", () => {
    render(
      <DonutChart
        data={PREFIX}
        omittedCount={OMITTED}
        otherSeriesLabel="Other tools"
        showSharePercent
        total={POPULATION_TOTAL}
      />
    );

    const residual = captured.data.at(-1);
    expect(captured.data).toHaveLength(PREFIX.length + 1);
    expect(residual).toEqual({
      key: CHART_OTHER_SERIES_KEY,
      label: `Other tools (${OMITTED})`,
      value: POPULATION_TOTAL - PREFIX_SUM,
    });
    // The share is over the population, not the prefix: 30 of 100, not 30 of 70.
    expect(screen.getByText("Bash 30%")).toBeInTheDocument();
    expect(
      screen.getByText(`Other tools (${OMITTED}) 30%`)
    ).toBeInTheDocument();
    expect(printedShares().reduce((sum, share) => sum + share, 0)).toBe(100);
    // The one slice that is not an entity takes the neutral, never a palette
    // slot a real tool could also be painted with.
    expect(sliceFills().at(-1)).toBe(CHART_OTHER_SERIES_COLOR);
    expect(sliceFills().slice(0, -1)).not.toContain(CHART_OTHER_SERIES_COLOR);
  });

  it("without the population, the same prefix is drawn against its own sum (the defect this fixes)", () => {
    render(<DonutChart data={PREFIX} showSharePercent />);

    expect(captured.data).toHaveLength(PREFIX.length);
    expect(screen.getByText("Bash 43%")).toBeInTheDocument();
    expect(
      screen.queryByText(startsWithDefaultOtherLabel)
    ).not.toBeInTheDocument();
  });

  it("never lets the residual overwrite a category that owns the reserved key", () => {
    const data: Slice[] = [
      ...PREFIX,
      {
        key: CHART_OTHER_SERIES_KEY,
        label: "A tool named like the band",
        value: 5,
      },
    ];
    render(
      <DonutChart
        data={data}
        omittedCount={OMITTED}
        otherSeriesLabel="Other tools"
        total={POPULATION_TOTAL}
      />
    );

    const keys = captured.data.map((slice) => slice.key);
    expect(captured.data).toHaveLength(data.length + 1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(screen.getByText("A tool named like the band")).toBeInTheDocument();
    expect(screen.getByText(`Other tools (${OMITTED})`)).toBeInTheDocument();
  });

  it("falls back to the bare noun when no label is supplied", () => {
    render(
      <DonutChart
        data={PREFIX}
        omittedCount={OMITTED}
        total={POPULATION_TOTAL}
      />
    );

    expect(screen.getByText(`Other (${OMITTED})`)).toBeInTheDocument();
  });

  it.each([
    ["no total", { total: undefined, omittedCount: OMITTED }],
    [
      "a total the slices already reach",
      { total: PREFIX_SUM, omittedCount: OMITTED },
    ],
    ["a total below the slice sum", { total: 50, omittedCount: OMITTED }],
    ["a non-finite total", { total: Number.NaN, omittedCount: OMITTED }],
    ["no omitted count", { total: POPULATION_TOTAL, omittedCount: undefined }],
    ["an omitted count of zero", { total: POPULATION_TOTAL, omittedCount: 0 }],
    [
      "a fractional omitted count",
      { total: POPULATION_TOTAL, omittedCount: 1.5 },
    ],
  ])("draws no residual with %s", (_name, props) => {
    render(
      <DonutChart
        data={PREFIX}
        omittedCount={props.omittedCount}
        otherSeriesLabel="Other tools"
        showSharePercent
        total={props.total}
      />
    );

    expect(captured.data).toHaveLength(PREFIX.length);
    expect(screen.queryByText(OTHER_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText("Bash 43%")).toBeInTheDocument();
  });

  it("keeps the zero-state keyed on the slice sum even when a population is supplied", () => {
    render(
      <DonutChart
        data={PREFIX.map((slice) => ({ ...slice, value: 0 }))}
        emptyMessage="No tool runs in this period"
        omittedCount={OMITTED}
        total={POPULATION_TOTAL}
      />
    );

    expect(screen.getByText("No tool runs in this period")).toBeInTheDocument();
    expect(screen.queryByTestId("slice")).not.toBeInTheDocument();
  });
});
