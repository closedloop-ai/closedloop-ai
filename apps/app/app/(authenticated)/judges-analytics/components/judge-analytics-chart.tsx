"use client";

import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import {
  ChartContainer,
  ChartTooltip,
} from "@repo/design-system/components/ui/chart";
import type React from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

type JudgeAnalyticsChartProps = {
  data: JudgeAggregateStats[];
  artifactType: string;
};

type BoxPlotDataPoint = {
  name: string;
  lowerWhisker: number;
  lowerBox: number;
  median: number;
  upperBox: number;
  upperWhisker: number;
  count: number;
};

const RechartsBarChart = BarChart as unknown as React.ComponentType<
  Record<string, unknown>
>;
const RechartsXAxis = XAxis as unknown as React.ComponentType<
  Record<string, unknown>
>;
const RechartsYAxis = YAxis as unknown as React.ComponentType<
  Record<string, unknown>
>;
const RechartsBar = Bar as unknown as React.ComponentType<
  Record<string, unknown>
>;

// Box plot vertical positions use the chart's global Y scale; the Bar slot is only for x/width.
type BoxPlotShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: BoxPlotDataPoint;
  fill?: string;
  /** Y domain [min, max] for the chart. Used to convert data values to pixel Y. */
  yDomain?: [number, number];
};

const BoxPlotShape: React.FC<BoxPlotShapeProps> = ({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  payload,
  fill,
  yDomain = [0, 1],
}) => {
  if (!payload) {
    return null;
  }

  const [yMin, yMax] = yDomain;
  const yRange = yMax - yMin;
  if (yRange <= 0) {
    return null;
  }

  // Recharts gives us a bar slot from yMin to median in data space. Derive the global
  // plot scale so we can position the box in chart coordinates (not slot coordinates).
  const median = payload.median;
  const dataSpan = median - yMin;
  const plotHeight = dataSpan > 0 ? (height * yRange) / dataSpan : height;
  const plotTop = y + height - plotHeight;

  const valueToY = (value: number) =>
    plotTop + (1 - (value - yMin) / yRange) * plotHeight;

  const whiskerLowerY = valueToY(payload.lowerWhisker);
  const boxLowerY = valueToY(payload.lowerBox);
  const medianY = valueToY(payload.median);
  const boxUpperY = valueToY(payload.upperBox);
  const whiskerUpperY = valueToY(payload.upperWhisker);

  const dataRange = payload.upperWhisker - payload.lowerWhisker;
  if (dataRange === 0) {
    const lineY = valueToY(payload.median);
    return (
      <g>
        <line
          stroke={fill || "#8884d8"}
          strokeWidth={2}
          x1={x}
          x2={x + width}
          y1={lineY}
          y2={lineY}
        />
      </g>
    );
  }

  const centerX = x + width / 2;
  const boxWidth = width * 0.6;
  const whiskerWidth = width * 0.3;

  return (
    <g>
      {/* Lower whisker line */}
      <line
        stroke={fill || "#8884d8"}
        strokeWidth={1}
        x1={centerX}
        x2={centerX}
        y1={whiskerLowerY}
        y2={boxLowerY}
      />
      {/* Lower whisker cap */}
      <line
        stroke={fill || "#8884d8"}
        strokeWidth={1}
        x1={centerX - whiskerWidth / 2}
        x2={centerX + whiskerWidth / 2}
        y1={whiskerLowerY}
        y2={whiskerLowerY}
      />

      {/* Box (from lowerBox to upperBox) */}
      <rect
        fill={fill || "#8884d8"}
        fillOpacity={0.6}
        height={boxLowerY - boxUpperY}
        stroke={fill || "#8884d8"}
        strokeWidth={1}
        width={boxWidth}
        x={centerX - boxWidth / 2}
        y={boxUpperY}
      />

      {/* Median line */}
      <line
        stroke="#000"
        strokeWidth={2}
        x1={centerX - boxWidth / 2}
        x2={centerX + boxWidth / 2}
        y1={medianY}
        y2={medianY}
      />

      {/* Upper whisker line */}
      <line
        stroke={fill || "#8884d8"}
        strokeWidth={1}
        x1={centerX}
        x2={centerX}
        y1={boxUpperY}
        y2={whiskerUpperY}
      />
      {/* Upper whisker cap */}
      <line
        stroke={fill || "#8884d8"}
        strokeWidth={1}
        x1={centerX - whiskerWidth / 2}
        x2={centerX + whiskerWidth / 2}
        y1={whiskerUpperY}
        y2={whiskerUpperY}
      />
    </g>
  );
};

// Custom tooltip component
const BoxPlotTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ payload: BoxPlotDataPoint }>;
}> = ({ active, payload }) => {
  if (!(active && payload) || payload.length === 0) {
    return null;
  }

  const data = payload[0].payload;

  return (
    <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <p className="mb-2 font-medium">{data.name}</p>
      <div className="grid gap-1.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Max:</span>
          <span className="font-medium font-mono">
            {data.upperWhisker.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Mean + 1σ:</span>
          <span className="font-medium font-mono">
            {data.upperBox.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Mean:</span>
          <span className="font-medium font-mono">
            {data.median.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Mean - 1σ:</span>
          <span className="font-medium font-mono">
            {data.lowerBox.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Min:</span>
          <span className="font-medium font-mono">
            {data.lowerWhisker.toFixed(2)}
          </span>
        </div>
        <div className="mt-1 flex justify-between gap-4 border-border/50 border-t pt-1">
          <span className="text-muted-foreground">Count:</span>
          <span className="font-medium font-mono">{data.count}</span>
        </div>
      </div>
    </div>
  );
};

export function JudgeAnalyticsChart({
  data,
  artifactType,
}: JudgeAnalyticsChartProps) {
  // Assumes data is pre-sorted descending by mean from API
  const boxPlotData: BoxPlotDataPoint[] = data.map((judge) => ({
    name: judge.judgeName,
    lowerWhisker: judge.min,
    lowerBox: Math.max(judge.mean - judge.stdDev, judge.min),
    median: judge.mean,
    upperBox: Math.min(judge.mean + judge.stdDev, judge.max),
    upperWhisker: judge.max,
    count: judge.artifactsEvaluated,
  }));

  // Y domain: adaptive to data, clamped to [0, 1]. Y_min = max(0, 0.8*min); Y_max = min(1, max).
  let yDomain: [number, number] = [0, 1];
  if (boxPlotData.length > 0) {
    const rawMin = Math.min(...boxPlotData.map((d) => d.lowerWhisker));
    const rawMax = Math.max(...boxPlotData.map((d) => d.upperWhisker));
    const yMin = Math.max(0, 0.8 * rawMin);
    let yMax = Math.min(1, rawMax);
    if (yMax <= yMin) {
      yMax = Math.max(yMin + 0.01, yMax);
    }
    yDomain = [yMin, yMax];
  }

  // Generate chart config with colors for each judge
  const chartConfig = boxPlotData.reduce(
    (acc, judge, index) => {
      const hue = (index * 360) / boxPlotData.length;
      acc[judge.name] = {
        label: judge.name,
        color: `hsl(${hue}, 70%, 50%)`,
      };
      return acc;
    },
    {} as Record<string, { label: string; color: string }>
  );

  return (
    <ChartContainer className="h-64 w-full" config={chartConfig}>
      <RechartsBarChart
        accessibilityLayer
        aria-label={`Box plot showing judge score distributions for ${artifactType}`}
        data={boxPlotData}
        margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
      >
        <RechartsXAxis
          angle={-45}
          dataKey="name"
          height={80}
          interval={0}
          textAnchor="end"
          tick={{ fontSize: 12 }}
        />
        <RechartsYAxis
          domain={yDomain}
          label={{ value: "Score", angle: -90, position: "insideLeft" }}
        />
        <ChartTooltip content={<BoxPlotTooltip />} />
        <RechartsBar
          dataKey="median"
          fill="#8884d8"
          shape={(props: unknown) => (
            <BoxPlotShape
              {...(props as BoxPlotShapeProps)}
              fill={(props as { fill?: string }).fill}
              yDomain={yDomain}
            />
          )}
        />
      </RechartsBarChart>
    </ChartContainer>
  );
}
