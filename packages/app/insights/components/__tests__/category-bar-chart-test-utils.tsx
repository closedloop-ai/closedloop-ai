import {
  CategoryBarChart,
  type CategoryDatum,
} from "@repo/design-system/components/ui/category-bar-chart";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";

type BarChartProps = {
  children?: ReactNode;
  data?: CategoryDatum[];
  onClick?: (event: unknown) => void;
};

type RechartsMockOptions = {
  // Invoked with the `data` array recharts receives on every render, so tests
  // can assert its reference identity (FEA-2499 selection-stability).
  onData?: (data: CategoryDatum[]) => void;
};

/**
 * Shared recharts mock object for the CategoryBarChart tracker /
 * selection-stability tests. The mocked `BarChart` renders one click button per
 * datum plus a few payload-shaped buttons the tracker test exercises; extra
 * buttons are inert for tests that ignore them. Pass `onData` to capture the
 * `data` reference recharts receives on each render.
 */
export function createCategoryBarChartRechartsMock(
  options: RechartsMockOptions = {}
) {
  const { onData } = options;

  return {
    Bar: () => null,
    CartesianGrid: () => null,
    ChartTooltip: () => null,
    Legend: () => null,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
    LabelList: () => null,
    ReferenceLine: (props: { x?: string; y?: string }) => (
      <div data-testid="tracker-line" data-x={props.x} data-y={props.y} />
    ),
    BarChart: ({ children, data = [], onClick }: BarChartProps) => {
      onData?.(data);
      return (
        <div data-testid="category-bar-chart">
          {data.map((datum, index) => (
            <button
              key={datum.key}
              onClick={() => onClick?.({ activeTooltipIndex: index })}
              type="button"
            >
              {`Click ${datum.label} ${datum.key}`}
            </button>
          ))}
          <button
            onClick={() =>
              onClick?.({
                activePayload: [{ payload: data[2] }],
                activeTooltipIndex: 0,
              })
            }
            type="button"
          >
            Payload wins over index
          </button>
          <button onClick={() => onClick?.({})} type="button">
            Missing payload
          </button>
          <button
            onClick={() =>
              onClick?.({
                activePayload: data
                  .slice(0, 2)
                  .map((datum) => ({ payload: datum })),
                activeTooltipIndex: 2,
              })
            }
            type="button"
          >
            Ambiguous payload
          </button>
          {children}
        </div>
      );
    },
  };
}

/**
 * Controlled wrapper that drives `selectedKey` from `onDatumClick`, mirroring
 * how consumers wire the chart. Shared by the tracker / selection-stability
 * tests to exercise selection-only re-renders.
 */
export function ControlledCategoryBarChart({
  data: chartData,
}: Pick<ComponentProps<typeof CategoryBarChart>, "data">) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  return (
    <CategoryBarChart
      data={chartData}
      onDatumClick={(datum) => setSelectedKey(datum.key)}
      selectedKey={selectedKey}
    />
  );
}
