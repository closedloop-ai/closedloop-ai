"use client";

import * as React from "react";
import { cn } from "@repo/design-system/lib/utils";

interface HexagonProgressProps {
  /** Progress value from 0 to 100 */
  value: number;
  /** Size of the hexagon in pixels */
  size?: number;
  /** Stroke width */
  strokeWidth?: number;
  /** Color for the progress stroke */
  progressColor?: string;
  /** Color for the background stroke */
  backgroundColor?: string;
  /** Whether to show the percentage text */
  showLabel?: boolean;
  /** Additional class name */
  className?: string;
}

/**
 * Generates hexagon path points for SVG
 * Hexagon is drawn starting from top vertex, clockwise
 */
function getHexagonPath(cx: number, cy: number, radius: number): string {
  const points: [number, number][] = [];

  // Start from top (12 o'clock position) and go clockwise
  for (let i = 0; i < 6; i++) {
    // Rotate by 30 degrees to start from top point
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    points.push([x, y]);
  }

  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ") + " Z";
}

/**
 * HexagonProgress component displays progress as a hexagonal stroke outline
 * The progress portion is shown in dark color, remaining in light gray
 */
function HexagonProgress({
  value,
  size = 24,
  strokeWidth = 2,
  progressColor = "currentColor",
  backgroundColor = "#e5e7eb",
  showLabel = true,
  className,
}: HexagonProgressProps) {
  // Clamp value between 0 and 100
  const clampedValue = Math.max(0, Math.min(100, value));

  // Calculate dimensions
  const padding = strokeWidth;
  const viewBoxSize = size;
  const center = viewBoxSize / 2;
  const radius = (viewBoxSize - strokeWidth * 2) / 2;

  // Calculate the perimeter of the hexagon (6 equal sides)
  const sideLength = radius; // For a regular hexagon inscribed in a circle
  const perimeter = 6 * sideLength;

  // Calculate stroke-dasharray and stroke-dashoffset for progress
  const progressLength = (clampedValue / 100) * perimeter;
  const dashArray = `${progressLength} ${perimeter}`;

  return (
    <div
      data-slot="hexagon-progress"
      className={cn("inline-flex items-center gap-1.5", className)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
        fill="none"
        className="shrink-0"
      >
        {/* Background hexagon stroke */}
        <path
          d={getHexagonPath(center, center, radius)}
          stroke={backgroundColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Progress hexagon stroke */}
        <path
          d={getHexagonPath(center, center, radius)}
          stroke={progressColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={dashArray}
          strokeDashoffset="0"
          className="transition-all duration-300 ease-in-out"
        />
      </svg>
      {showLabel && (
        <span className="text-sm font-medium tabular-nums">{Math.round(clampedValue)}%</span>
      )}
    </div>
  );
}

export { HexagonProgress };
export type { HexagonProgressProps };
