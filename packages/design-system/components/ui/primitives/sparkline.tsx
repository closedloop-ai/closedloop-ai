"use client";

import { useMemo } from "react";

type SparklineProps = {
  values: Array<number | null | undefined>;
  width?: number;
  height?: number;
  className?: string;
  stroke?: string;
};

export function Sparkline({
  values,
  width = 80,
  height = 20,
  className,
  stroke = "currentColor",
}: SparklineProps) {
  const points = useMemo(() => {
    const clean = values
      .map((value) =>
        typeof value === "number" && Number.isFinite(value) ? value : null
      )
      .filter((value): value is number => value !== null);
    if (clean.length < 2) {
      return null;
    }
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const range = max - min || 1;
    const step = width / (clean.length - 1);
    return clean
      .map((value, index) => {
        const x = index * step;
        const y = height - ((value - min) / range) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [height, values, width]);

  if (!points) {
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
      <polyline
        fill="none"
        points={points}
        stroke={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
