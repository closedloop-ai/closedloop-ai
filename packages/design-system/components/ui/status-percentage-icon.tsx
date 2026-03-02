"use client";

import * as React from "react";
import { cn } from "@repo/design-system/lib/utils";
import {
  CENTER,
  CIRCUMFERENCE,
  FilledCheckCircle,
  INNER_CIRCUMFERENCE,
  INNER_PATH_RADIUS,
  INNER_STROKE_WIDTH,
  RADIUS,
  STROKE_WIDTH,
} from "./status-icon-shared";

interface StatusPercentageIconProps
  extends React.SVGAttributes<SVGSVGElement> {
  /** Completion percentage (0-100) */
  value: number;
  /** Icon size in pixels (default 16) */
  size?: 16 | 20;
  /** Show spinning arc for AI/agent processing. Ignored when value is 100 (complete state). */
  thinking?: boolean;
}

function StatusPercentageIcon({
  value,
  size = 16,
  thinking = false,
  className,
  ...props
}: StatusPercentageIconProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const defaultLabel = `${Math.round(clamped)}% complete`;

  if (clamped >= 100) {
    return (
      <svg
        role="img"
        aria-label={defaultLabel}
        data-slot="status-percentage-icon"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        className={cn("shrink-0", className)}
        {...props}
      >
        <FilledCheckCircle fill="var(--success)" />
      </svg>
    );
  }

  const outerOffset = CIRCUMFERENCE * (1 - clamped / 100);
  const innerOffset = INNER_CIRCUMFERENCE * (1 - clamped / 100);
  const spinnerDash = CIRCUMFERENCE * 0.25;
  const spinnerGap = CIRCUMFERENCE - spinnerDash;

  return (
    <svg
      role="img"
      aria-label={defaultLabel}
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
          stroke="var(--thinking)"
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
