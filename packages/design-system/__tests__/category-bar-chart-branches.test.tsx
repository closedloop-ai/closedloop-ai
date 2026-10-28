import {
  CategoryBarChart,
  type CategoryDatum,
} from "@closedloop-ai/design-system/components/ui/category-bar-chart";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recharts derives click state and on-bar labels from laid-out geometry that
 * jsdom never produces (see category-bar-chart.test.tsx). These tests replace
 * the Recharts leaf components with prop-capturing stubs so the chart's own
 * click-resolution and formatting logic can be driven with explicit inputs.
 * The assertions are on what that logic returns, not on the stubs.
 */

type Props = Record<string, unknown> & { children?: ReactNode };

const captured: {
  barChart?: Props;
  xAxis: Props[];
  yAxis: Props[];
  referenceLine?: Props;
  labelList?: Props;
} = { xAxis: [], yAxis: [] };

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    BarChart: (props: Props) => {
      captured.barChart = props;
      return <div>{props.children}</div>;
    },
    Bar: (props: Props) => <>{props.children}</>,
    CartesianGrid: () => null,
    Tooltip: () => null,
    XAxis: (props: Props) => {
      captured.xAxis.push(props);
      return null;
    },
    YAxis: (props: Props) => {
      captured.yAxis.push(props);
      return null;
    },
    ReferenceLine: (props: Props) => {
      captured.referenceLine = props;
      return null;
    },
    LabelList: (props: Props) => {
      captured.labelList = props;
      return null;
    },
  };
});

const DATA: CategoryDatum[] = [
  { key: "claude", label: "Claude", value: 30 },
  { key: "codex", label: "Codex", value: 10 },
];

function clickChart(event: unknown) {
  const onClick = captured.barChart?.onClick;
  if (typeof onClick !== "function") {
    throw new Error("BarChart onClick not wired");
  }
  onClick(event);
}

function fn<T>(value: unknown): T {
  if (typeof value !== "function") {
    throw new Error("expected a function prop");
  }
  return value as T;
}

beforeEach(() => {
  captured.barChart = undefined;
  captured.xAxis = [];
  captured.yAxis = [];
  captured.referenceLine = undefined;
  captured.labelList = undefined;
});

afterEach(cleanup);

describe("CategoryBarChart click resolution", () => {
  it("does not wire a chart click handler without onDatumClick", () => {
    render(<CategoryBarChart data={DATA} />);
    expect(captured.barChart?.onClick).toBeUndefined();
  });

  it("resolves the datum from a single matching activePayload key", () => {
    const onDatumClick = vi.fn();
    render(<CategoryBarChart data={DATA} onDatumClick={onDatumClick} />);
    clickChart({
      activePayload: [
        null,
        { payload: null },
        { payload: { key: 42 } },
        { payload: { key: "unknown" } },
        { payload: { key: "codex" } },
      ],
    });
    expect(onDatumClick).toHaveBeenCalledTimes(1);
    expect(onDatumClick).toHaveBeenCalledWith(DATA[1]);
  });

  it("resolves nothing when activePayload matches zero or several keys", () => {
    const onDatumClick = vi.fn();
    render(<CategoryBarChart data={DATA} onDatumClick={onDatumClick} />);
    clickChart({ activePayload: [] });
    clickChart({
      activePayload: [
        { payload: { key: "claude" } },
        { payload: { key: "codex" } },
      ],
    });
    // activePayload wins even when activeTooltipIndex would resolve a datum.
    clickChart({ activePayload: [], activeTooltipIndex: 0 });
    expect(onDatumClick).not.toHaveBeenCalled();
  });

  it.each([
    [0, "claude"],
    ["1", "codex"],
  ] as const)("resolves the datum from activeTooltipIndex %j", (index, key) => {
    const onDatumClick = vi.fn();
    render(<CategoryBarChart data={DATA} onDatumClick={onDatumClick} />);
    clickChart({ activeTooltipIndex: index });
    expect(onDatumClick).toHaveBeenCalledWith(
      DATA.find((datum) => datum.key === key)
    );
  });

  it.each([
    ["non-object event", null],
    ["fractional index", { activeTooltipIndex: 0.5 }],
    ["fractional string index", { activeTooltipIndex: "0.5" }],
    ["blank string index", { activeTooltipIndex: "  " }],
    ["out-of-range index", { activeTooltipIndex: 5 }],
    ["missing index", {}],
  ])("does not call onDatumClick for a %s", (_label, event) => {
    const onDatumClick = vi.fn();
    render(<CategoryBarChart data={DATA} onDatumClick={onDatumClick} />);
    clickChart(event);
    expect(onDatumClick).not.toHaveBeenCalled();
  });
});

describe("CategoryBarChart axis and label formatting", () => {
  it("falls back to the raw key for a category tick with no label (vertical)", () => {
    render(<CategoryBarChart data={DATA} />);
    const format = fn<(key: unknown) => string>(
      captured.xAxis[0]?.tickFormatter
    );
    expect(format("claude")).toBe("Claude");
    expect(format("missing")).toBe("missing");
  });

  it("falls back to the raw key for a category tick with no label (horizontal)", () => {
    render(<CategoryBarChart data={DATA} horizontal />);
    const format = fn<(key: unknown) => string>(
      captured.yAxis[0]?.tickFormatter
    );
    expect(format("codex")).toBe("Codex");
    expect(format("missing")).toBe("missing");
  });

  it("formats numeric-string ticks and passes non-finite ticks through", () => {
    render(<CategoryBarChart data={DATA} />);
    const format = fn<(value: number | string) => string>(
      captured.yAxis[0]?.tickFormatter
    );
    expect(format("1234")).toBe("1,234");
    expect(format("abc")).toBe("abc");
  });

  it("places the selected reference line on y in horizontal layout", () => {
    render(<CategoryBarChart data={DATA} horizontal selectedKey="codex" />);
    expect(captured.referenceLine?.y).toBe("codex");
    expect(captured.referenceLine?.x).toBeUndefined();
  });

  it("places the selected reference line on x in vertical layout", () => {
    render(<CategoryBarChart data={DATA} selectedKey="codex" />);
    expect(captured.referenceLine?.x).toBe("codex");
    expect(captured.referenceLine?.y).toBeUndefined();
  });

  it.each([true, false])(
    "keeps the default margin when value labels are off (horizontal=%s)",
    (horizontal) => {
      render(<CategoryBarChart data={DATA} horizontal={horizontal} />);
      expect(captured.labelList).toBeUndefined();
      expect(captured.barChart?.margin).toEqual({
        top: 8,
        right: 12,
        bottom: 4,
        left: 4,
      });
    }
  );

  it("puts value labels to the right with right margin when horizontal", () => {
    render(<CategoryBarChart data={DATA} horizontal showValueLabels />);
    expect(captured.labelList?.position).toBe("right");
    expect(captured.barChart?.margin).toMatchObject({ right: 52, top: 8 });
    const format = fn<(value: unknown) => string>(
      captured.labelList?.formatter
    );
    expect(format(1500)).toBe("1,500");
  });

  it("puts value labels on top with top margin when vertical", () => {
    render(
      <CategoryBarChart
        data={DATA}
        showValueLabels
        valueFormatter={(value) => `$${value}`}
      />
    );
    expect(captured.labelList?.position).toBe("top");
    expect(captured.barChart?.margin).toMatchObject({ top: 20, right: 12 });
    const format = fn<(value: unknown) => string>(
      captured.labelList?.formatter
    );
    expect(format("7")).toBe("$7");
  });
});
