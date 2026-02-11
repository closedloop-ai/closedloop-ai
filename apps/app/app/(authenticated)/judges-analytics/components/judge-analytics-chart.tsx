"use client";

import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import { ChartContainer } from "@repo/design-system/components/ui/chart";
import type React from "react";
import { Bar, BarChart, Tooltip, XAxis, YAxis } from "recharts";

type JudgeAnalyticsChartProps = {
  data: JudgeAggregateStats[];
  artifactSubtype: string;
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

// Custom shape component for rendering box plots
const BoxPlotShape: React.FC<{
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: BoxPlotDataPoint;
  fill?: string;
}> = ({ x = 0, y = 0, width = 0, height = 0, payload, fill }) => {
  if (!payload) {
    return null;
  }

  // Calculate the Y positions for each part of the box plot
  // We need to convert from data values to pixel coordinates
  // Since we don't have direct access to the scale, we'll calculate proportionally
  const chartHeight = height;
  const chartY = y;

  // Get the data range
  const dataMin = payload.lowerWhisker;
  const dataMax = payload.upperWhisker;
  const dataRange = dataMax - dataMin;

  if (dataRange === 0) {
    // All values are the same - just draw a single horizontal line
    const lineY = chartY + chartHeight / 2;
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

  // Convert data values to pixel positions (inverted Y-axis)
  const valueToY = (value: number) => {
    const proportion = (value - dataMin) / dataRange;
    return chartY + chartHeight * (1 - proportion);
  };

  const whiskerLowerY = valueToY(payload.lowerWhisker);
  const boxLowerY = valueToY(payload.lowerBox);
  const medianY = valueToY(payload.median);
  const boxUpperY = valueToY(payload.upperBox);
  const whiskerUpperY = valueToY(payload.upperWhisker);

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
  artifactSubtype,
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
      <BarChart
        accessibilityLayer
        aria-label={`Box plot showing judge score distributions for ${artifactSubtype}`}
        data={boxPlotData}
        margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
      >
        <XAxis
          angle={-45}
          dataKey="name"
          height={80}
          interval={0}
          textAnchor="end"
          tick={{ fontSize: 12 }}
        />
        <YAxis
          domain={[0, "auto"]}
          label={{ value: "Score", angle: -90, position: "insideLeft" }}
        />
        <Tooltip content={<BoxPlotTooltip />} />
        <Bar
          dataKey="median"
          fill="#8884d8"
          shape={(props: unknown) => (
            <BoxPlotShape
              {...(props as Parameters<typeof BoxPlotShape>[0])}
              fill={(props as { fill?: string }).fill}
            />
          )}
        />
      </BarChart>
    </ChartContainer>
  );
}
