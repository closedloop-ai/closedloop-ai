import {
  CategoryBarChart,
  type CategoryDatum,
} from "@repo/design-system/components/ui/category-bar-chart";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Render Bar's children (so the LabelList shows), and have the mocked LabelList
// exercise the real `formatter` prop across large/small/tiny values so we can
// assert the on-bar labels are formatted (currency) and positioned correctly.
const LABEL_SAMPLE_VALUES = [36_400, 4.2, 0.03];

vi.mock("recharts", () => ({
  Bar: ({ children }: { children?: ReactNode }) => (
    <div data-testid="bar">{children}</div>
  ),
  BarChart: ({ children }: { children?: ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  CartesianGrid: () => null,
  LabelList: ({
    formatter,
    position,
  }: {
    formatter?: (value: number | string) => ReactNode;
    position?: string;
  }) => (
    <ul data-position={position} data-testid="value-labels">
      {LABEL_SAMPLE_VALUES.map((value) => (
        <li key={value}>{formatter?.(value)}</li>
      ))}
    </ul>
  ),
  Legend: () => null,
  ReferenceLine: () => null,
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => children,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const spendData: CategoryDatum[] = [
  { key: "opus", label: "Claude Opus", value: 36_400 },
  { key: "sonnet", label: "Claude Sonnet", value: 4.2 },
  { key: "haiku", label: "Claude Haiku", value: 0.03 },
];
const formatCurrency = (value: number) => `$${value.toFixed(2)}`;

describe("CategoryBarChart value labels", () => {
  it("renders each bar's value on the chart, formatted, when showValueLabels is set", () => {
    render(
      <CategoryBarChart
        data={spendData}
        horizontal
        showValueLabels
        valueFormatter={formatCurrency}
      />
    );

    const labels = screen.getByTestId("value-labels");
    // Horizontal bars grow rightward; labels sit past the bar's free end.
    expect(labels).toHaveAttribute("data-position", "right");
    // Large, mid, and sub-cent values all render via the same formatter used by
    // the tooltip — nothing is hidden behind hover.
    expect(labels).toHaveTextContent("$36400.00");
    expect(labels).toHaveTextContent("$4.20");
    expect(labels).toHaveTextContent("$0.03");
  });

  it("omits on-bar labels by default so existing charts stay tooltip-only", () => {
    render(
      <CategoryBarChart
        data={spendData}
        horizontal
        valueFormatter={formatCurrency}
      />
    );

    expect(screen.queryByTestId("value-labels")).not.toBeInTheDocument();
  });
});
