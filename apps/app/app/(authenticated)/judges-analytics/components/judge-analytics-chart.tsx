"use client";

import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
import {
  ChartContainer,
  ChartTooltip,
} from "@repo/design-system/components/ui/chart";
import type React from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { TooltipRow, TooltipShell } from "./chart-tooltip";

type JudgeAnalyticsChartProps = {
  data: JudgeAggregateStats[];
  artifactType: string;
};

type BoxPlotDataPoint = {
  name: string;
  // Eval stats
  lowerWhisker: number;
  lowerBox: number;
  median: number;
  upperBox: number;
  upperWhisker: number;
  count: number;
  // Human stats (null when no human ratings)
  humanLowerWhisker: number | null;
  humanLowerBox: number | null;
  humanMedian: number | null;
  humanUpperBox: number | null;
  humanUpperWhisker: number | null;
};

const EVAL_COLOR = "#2563EB";
const HUMAN_COLOR = "#EAB308";

// Box plot vertical positions use the chart's global Y scale; the Bar slot is only for x/width.
type BoxPlotShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: BoxPlotDataPoint;
  /** Y domain [min, max] for the chart. Used to convert data values to pixel Y. */
  yDomain?: [number, number];
};

type CandlestickParams = {
  centerX: number;
  halfWidth: number;
  valueToY: (value: number) => number;
  lowerWhisker: number;
  lowerBox: number;
  median: number;
  upperBox: number;
  upperWhisker: number;
  color: string;
};

/** Renders a single candlestick (whiskers + box + median line). */
function renderCandlestick(params: CandlestickParams): React.ReactNode {
  const { centerX, halfWidth, valueToY, color } = params;
  const boxWidth = halfWidth * 0.7;
  const whiskerWidth = halfWidth * 0.35;

  const whiskerLowerY = valueToY(params.lowerWhisker);
  const boxLowerY = valueToY(params.lowerBox);
  const medianY = valueToY(params.median);
  const boxUpperY = valueToY(params.upperBox);
  const whiskerUpperY = valueToY(params.upperWhisker);

  const dataRange = params.upperWhisker - params.lowerWhisker;
  if (dataRange === 0) {
    return (
      <line
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={2}
        x1={centerX - halfWidth / 2}
        x2={centerX + halfWidth / 2}
        y1={medianY}
        y2={medianY}
      />
    );
  }

  return (
    <g>
      <line
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={1}
        x1={centerX}
        x2={centerX}
        y1={whiskerLowerY}
        y2={boxLowerY}
      />
      <line
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={1}
        x1={centerX - whiskerWidth / 2}
        x2={centerX + whiskerWidth / 2}
        y1={whiskerLowerY}
        y2={whiskerLowerY}
      />
      <rect
        fill={color}
        fillOpacity={0.35}
        height={boxLowerY - boxUpperY}
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={1}
        width={boxWidth}
        x={centerX - boxWidth / 2}
        y={boxUpperY}
      />
      <line
        stroke={color}
        strokeWidth={2}
        x1={centerX - boxWidth / 2}
        x2={centerX + boxWidth / 2}
        y1={medianY}
        y2={medianY}
      />
      <line
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={1}
        x1={centerX}
        x2={centerX}
        y1={boxUpperY}
        y2={whiskerUpperY}
      />
      <line
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={1}
        x1={centerX - whiskerWidth / 2}
        x2={centerX + whiskerWidth / 2}
        y1={whiskerUpperY}
        y2={whiskerUpperY}
      />
    </g>
  );
}

const BoxPlotShape: React.FC<BoxPlotShapeProps> = ({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  payload,
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
  const dataSpan = payload.median - yMin;
  const plotHeight = dataSpan > 0 ? (height * yRange) / dataSpan : height;
  const plotTop = y + height - plotHeight;

  const valueToY = (value: number) =>
    plotTop + (1 - (value - yMin) / yRange) * plotHeight;

  const centerX = x + width / 2;
  const halfWidth = width * 0.5;

  // Extract human stats into a typed object only when all fields are present
  const humanStats =
    payload.humanMedian !== null &&
    payload.humanLowerWhisker !== null &&
    payload.humanLowerBox !== null &&
    payload.humanUpperBox !== null &&
    payload.humanUpperWhisker !== null
      ? {
          lowerWhisker: payload.humanLowerWhisker,
          lowerBox: payload.humanLowerBox,
          median: payload.humanMedian,
          upperBox: payload.humanUpperBox,
          upperWhisker: payload.humanUpperWhisker,
        }
      : null;

  return (
    <g>
      {renderCandlestick({
        centerX,
        halfWidth,
        valueToY,
        lowerWhisker: payload.lowerWhisker,
        lowerBox: payload.lowerBox,
        median: payload.median,
        upperBox: payload.upperBox,
        upperWhisker: payload.upperWhisker,
        color: EVAL_COLOR,
      })}
      {humanStats &&
        renderCandlestick({
          centerX,
          halfWidth,
          valueToY,
          ...humanStats,
          color: HUMAN_COLOR,
        })}
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
    <TooltipShell title={data.name}>
      <p className="font-medium text-xs" style={{ color: EVAL_COLOR }}>
        Eval
      </p>
      <TooltipRow label="Max:" value={data.upperWhisker.toFixed(2)} />
      <TooltipRow label="Mean + 1σ:" value={data.upperBox.toFixed(2)} />
      <TooltipRow label="Mean:" value={data.median.toFixed(2)} />
      <TooltipRow label="Mean - 1σ:" value={data.lowerBox.toFixed(2)} />
      <TooltipRow label="Min:" value={data.lowerWhisker.toFixed(2)} />
      {data.humanMedian !== null && (
        <>
          <p
            className="mt-1 border-border/50 border-t pt-1 font-medium text-xs"
            style={{ color: HUMAN_COLOR }}
          >
            Human
          </p>
          <TooltipRow label="Max:" value={data.humanUpperWhisker!.toFixed(2)} />
          <TooltipRow
            label="Mean + 1σ:"
            value={data.humanUpperBox!.toFixed(2)}
          />
          <TooltipRow label="Mean:" value={data.humanMedian.toFixed(2)} />
          <TooltipRow
            label="Mean - 1σ:"
            value={data.humanLowerBox!.toFixed(2)}
          />
          <TooltipRow label="Min:" value={data.humanLowerWhisker!.toFixed(2)} />
        </>
      )}
      <div className="mt-1 flex justify-between gap-4 border-border/50 border-t pt-1">
        <span className="text-muted-foreground">Count:</span>
        <span className="font-medium font-mono">{data.count}</span>
      </div>
    </TooltipShell>
  );
};

/** Computes box bounds clamped to whisker range. */
function computeBoxBounds(
  mean: number,
  stdDev: number,
  min: number,
  max: number
): { lowerBox: number; upperBox: number } {
  return {
    lowerBox: Math.max(mean - stdDev, min),
    upperBox: Math.min(mean + stdDev, max),
  };
}

export function JudgeAnalyticsChart({
  data,
  artifactType,
}: JudgeAnalyticsChartProps) {
  // Assumes data is pre-sorted descending by mean from API
  const boxPlotData: BoxPlotDataPoint[] = data.map((judge) => {
    const evalBounds = computeBoxBounds(
      judge.mean,
      judge.stdDev,
      judge.min,
      judge.max
    );

    const hasHuman =
      judge.humanMean !== null &&
      judge.humanStdDev !== null &&
      judge.humanMin !== null &&
      judge.humanMax !== null;
    const humanBounds = hasHuman
      ? computeBoxBounds(
          judge.humanMean!,
          judge.humanStdDev!,
          judge.humanMin!,
          judge.humanMax!
        )
      : null;

    return {
      name: judge.judgeName,
      lowerWhisker: judge.min,
      lowerBox: evalBounds.lowerBox,
      median: judge.mean,
      upperBox: evalBounds.upperBox,
      upperWhisker: judge.max,
      count: judge.artifactsEvaluated,
      humanLowerWhisker: judge.humanMin,
      humanLowerBox: humanBounds?.lowerBox ?? null,
      humanMedian: judge.humanMean,
      humanUpperBox: humanBounds?.upperBox ?? null,
      humanUpperWhisker: judge.humanMax,
    };
  });

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

  // Y domain: adaptive to data, clamped to [0, 1]. Include human whiskers in bounds.
  let yDomain: [number, number] = [0, 1];
  if (boxPlotData.length > 0) {
    const allValues = boxPlotData.flatMap((d) => {
      const vals = [d.lowerWhisker, d.upperWhisker];
      if (d.humanLowerWhisker !== null) {
        vals.push(d.humanLowerWhisker);
      }
      if (d.humanUpperWhisker !== null) {
        vals.push(d.humanUpperWhisker);
      }
      return vals;
    });
    const rawMin = Math.min(...allValues);
    const rawMax = Math.max(...allValues);
    const yMin = Math.max(0, 0.8 * rawMin);
    let yMax = Math.min(1, rawMax);
    if (yMax <= yMin) {
      yMax = Math.max(yMin + 0.01, yMax);
    }
    yDomain = [yMin, yMax];
  }

  return (
    <ChartContainer className="h-64 w-full" config={chartConfig}>
      <BarChart
        accessibilityLayer
        aria-label={`Box plot showing judge score distributions for ${artifactType}`}
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
          domain={yDomain}
          label={{ value: "Score", angle: -90, position: "insideLeft" }}
          tickFormatter={(v: number) => v.toFixed(1)}
        />
        <ChartTooltip content={<BoxPlotTooltip />} />
        <Bar
          dataKey="median"
          fill={EVAL_COLOR}
          shape={(props: unknown) => (
            <BoxPlotShape {...(props as BoxPlotShapeProps)} yDomain={yDomain} />
          )}
        />
      </BarChart>
    </ChartContainer>
  );
}
