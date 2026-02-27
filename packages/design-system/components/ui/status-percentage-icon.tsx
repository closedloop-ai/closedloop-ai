"use client";

import * as React from "react";
import { cn } from "@repo/design-system/lib/utils";

interface StatusPercentageIconProps
  extends React.SVGAttributes<SVGSVGElement> {
  /** Completion percentage (0-100) */
  value: number;
  /** Icon size in pixels (default 16) */
  size?: 16 | 20;
  /** Show spinning arc for AI/agent processing */
  thinking?: boolean;
}

const CENTER = 10;
const RADIUS = 9;
const STROKE_WIDTH = 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Inner filled circle: thick stroke on a small path creates a solid disk.
const INNER_PATH_RADIUS = 3;
const INNER_STROKE_WIDTH = INNER_PATH_RADIUS * 2;
const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_PATH_RADIUS;

function StatusPercentageIcon({
  value,
  size = 16,
  thinking = false,
  className,
  ...props
}: StatusPercentageIconProps) {
  const clamped = Math.max(0, Math.min(100, value));

  if (clamped >= 100) {
    return (
      <svg
        data-slot="status-percentage-icon"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        className={cn("shrink-0", className)}
        {...props}
      >
        <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill="var(--success)" />
        <path
          d="M6.5 10.5L9.5 13.5L14 7.5"
          stroke="var(--background)"
          strokeWidth={1.66}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }

  const outerOffset = CIRCUMFERENCE * (1 - clamped / 100);
  const innerOffset = INNER_CIRCUMFERENCE * (1 - clamped / 100);
  const spinnerDash = CIRCUMFERENCE * 0.25;
  const spinnerGap = CIRCUMFERENCE - spinnerDash;

  return (
    <svg
      data-slot="status-percentage-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={cn("shrink-0", className)}
      {...props}
    >
      {/* Outer track circle */}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        stroke="var(--progress)"
        strokeWidth={STROKE_WIDTH}
        fill="none"
      />
      {/* Outer progress arc — hidden when thinking (replaced by spinner) */}
      {!thinking && clamped > 0 && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          stroke="var(--progress-foreground)"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={outerOffset}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
          className="transition-all duration-300 ease-in-out"
        />
      )}
      {/* Thinking spinner — replaces outer progress arc */}
      {thinking && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          stroke="var(--progress-foreground)"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${spinnerDash} ${spinnerGap}`}
          className="animate-spin origin-center"
        />
      )}
      {/* Inner filled circle — always visible, shows percentage */}
      {clamped > 0 && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_PATH_RADIUS}
          stroke="var(--progress-foreground)"
          strokeWidth={INNER_STROKE_WIDTH}
          fill="none"
          strokeDasharray={INNER_CIRCUMFERENCE}
          strokeDashoffset={innerOffset}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
          className="transition-all duration-300 ease-in-out"
        />
      )}
    </svg>
  );
}

export { StatusPercentageIcon };
export type { StatusPercentageIconProps };
