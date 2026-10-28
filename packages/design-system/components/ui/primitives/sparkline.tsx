"use client";

import { useMemo } from "react";

type SparklineProps = {
  values: readonly (number | null | undefined)[];
  width?: number;
  height?: number;
  className?: string;
  stroke?: string;
};

/** Two points make a line; one is a dot claiming to be a trend. */
const MIN_POINTS = 2;
const STROKE_WIDTH = 1.5;
/** Half the stroke, so an isolated point is exactly its own round line cap. */
const POINT_RADIUS = STROKE_WIDTH / 2;

type SparklinePoint = { x: number; y: number };

/**
 * The drawable runs of a series, gaps held in place (ISS-10363, whitlockk review on
 * #7448).
 *
 * An unmeasured bucket keeps its SLOT on the x axis and breaks the stroke there.
 * Dropping it instead — which this drew before — closed the line over the
 * unmeasured period and re-spaced its neighbours, so `[10, null, 30]` rendered
 * as one uninterrupted full-width rise: a claim about a period we did not
 * measure, made out of the two we did.
 *
 * A run of one survives as a run rather than being discarded, because the two
 * measured ends of `[10, null, 30]` are the whole content of that series; the
 * caller draws such a run as a dot so a real measurement is never rendered as
 * nothing.
 */
function buildRuns(
  values: readonly (number | null | undefined)[],
  width: number,
  height: number
): SparklinePoint[][] | null {
  const slots = values.map((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null
  );
  const finite = slots.filter((value): value is number => value !== null);
  if (finite.length < MIN_POINTS) {
    return null;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min || 1;
  // Spaced over every slot, gaps included, so a point's x position is WHEN it
  // happened rather than its rank among the buckets that happened to be known.
  const step = slots.length > 1 ? width / (slots.length - 1) : 0;
  const runs: SparklinePoint[][] = [];
  let run: SparklinePoint[] = [];
  for (const [index, value] of slots.entries()) {
    if (value === null) {
      if (run.length > 0) {
        runs.push(run);
        run = [];
      }
      continue;
    }
    run.push({
      x: index * step,
      y: height - ((value - min) / range) * height,
    });
  }
  if (run.length > 0) {
    runs.push(run);
  }
  return runs;
}

function runKey(run: readonly SparklinePoint[]): string {
  return run.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

export function Sparkline({
  values,
  width = 80,
  height = 20,
  className,
  stroke = "currentColor",
}: SparklineProps) {
  const runs = useMemo(
    () => buildRuns(values, width, height),
    [height, values, width]
  );

  if (!runs) {
    return null;
  }

  return (
    <svg
      aria-hidden="true"
      className={className}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      {runs.map(([first, ...rest]) => {
        const run = [first, ...rest];
        const key = runKey(run);
        if (rest.length < MIN_POINTS - 1) {
          return (
            <circle
              cx={first.x.toFixed(1)}
              cy={first.y.toFixed(1)}
              fill={stroke}
              key={key}
              r={POINT_RADIUS}
            />
          );
        }
        return (
          <polyline
            fill="none"
            key={key}
            points={key}
            stroke={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={STROKE_WIDTH}
          />
        );
      })}
    </svg>
  );
}
