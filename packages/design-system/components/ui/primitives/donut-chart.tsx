"use client";

import { useId, useMemo } from "react";
import { formatCompactNumber } from "../utils";

type DonutSegment = {
  label: string;
  value: number;
  color: string;
};

type DonutChartProps = {
  segments: DonutSegment[];
  formatTotal?: (total: number) => string;
  centerLabel?: string;
};

/**
 * @deprecated Use the cataloged DonutChart from `@closedloop-ai/design-system/components/ui/donut-chart`
 * (DonutDatum API). This primitive variant has no remaining consumers and is a
 * candidate for removal in a follow-up design-system cleanup.
 */
export function DonutChart({
  segments,
  formatTotal = formatCompactNumber,
  centerLabel = "total",
}: DonutChartProps) {
  const titleId = useId();
  const total = useMemo(
    () => segments.reduce((sum, segment) => sum + segment.value, 0),
    [segments]
  );

  if (total <= 0) {
    return <div className="text-muted-foreground text-xs">No data</div>;
  }

  const radius = 52;
  const center = 64;
  const stroke = 18;
  const circumference = 2 * Math.PI * radius;
  let offset = circumference / 4;

  return (
    <div className="flex w-full items-center justify-center gap-6">
      <svg
        aria-labelledby={titleId}
        className="shrink-0"
        height={128}
        role="img"
        viewBox="0 0 128 128"
        width={128}
      >
        <title id={titleId}>Monitor donut chart</title>
        <circle
          cx={center}
          cy={center}
          fill="none"
          r={radius}
          stroke="hsl(var(--muted))"
          strokeWidth={stroke}
        />
        {segments.map((segment) => {
          const dash = (segment.value / total) * circumference;
          const gap = circumference - dash;
          const currentOffset = offset;
          offset -= dash;
          return (
            <circle
              cx={center}
              cy={center}
              fill="none"
              key={segment.label}
              r={radius}
              stroke={segment.color}
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={currentOffset}
              strokeLinecap="round"
              strokeWidth={stroke}
            >
              <title>{`${segment.label}: ${formatCompactNumber(segment.value)} (${Math.round((segment.value / total) * 100)}%)`}</title>
            </circle>
          );
        })}
        <text
          className="fill-foreground"
          fontSize={11}
          textAnchor="middle"
          x={center}
          y={center - 6}
        >
          {formatTotal(total)}
        </text>
        <text
          className="fill-muted-foreground"
          fontSize={9}
          textAnchor="middle"
          x={center}
          y={center + 10}
        >
          {centerLabel}
        </text>
      </svg>
      <div className="space-y-2">
        {segments.map((segment) => (
          <div className="flex items-center gap-2 text-xs" key={segment.label}>
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: segment.color }}
            />
            <span className="text-muted-foreground">{segment.label}</span>
            <span className="ml-auto pl-4 text-right">
              <span className="font-medium text-foreground">
                {formatCompactNumber(segment.value)}
              </span>
              <span className="ml-2 text-muted-foreground">
                {Math.round((segment.value / total) * 100)}%
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
