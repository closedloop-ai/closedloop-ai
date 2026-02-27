"use client";

import * as React from "react";
import { cn } from "@repo/design-system/lib/utils";

type StatusIconStatus =
  | "backlog"
  | "todo"
  | "in-progress"
  | "in-review"
  | "complete"
  | "wont-do";

interface StatusIconProps
  extends React.SVGAttributes<SVGSVGElement> {
  /** Named phase status */
  status: StatusIconStatus;
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

type StatusConfig = {
  percentage: number;
  color: string;
  dashed: boolean;
  filled: boolean;
  icon: "check" | "x" | null;
};

function getStatusConfig(status: StatusIconStatus): StatusConfig {
  switch (status) {
    case "backlog": {
      return { percentage: 0, color: "var(--progress)", dashed: true, filled: false, icon: null };
    }
    case "todo": {
      return { percentage: 0, color: "var(--progress)", dashed: false, filled: false, icon: null };
    }
    case "in-progress": {
      return { percentage: 48.5, color: "var(--progress-foreground)", dashed: false, filled: false, icon: null };
    }
    case "in-review": {
      return { percentage: 73.5, color: "var(--warning)", dashed: false, filled: false, icon: null };
    }
    case "complete": {
      return { percentage: 100, color: "var(--success)", dashed: false, filled: true, icon: "check" };
    }
    case "wont-do": {
      return { percentage: 100, color: "var(--foreground)", dashed: false, filled: true, icon: "x" };
    }
  }
}

function StatusIcon({
  status,
  size = 16,
  thinking = false,
  className,
  ...props
}: StatusIconProps) {
  const config = getStatusConfig(status);

  if (config.filled) {
    return (
      <svg
        data-slot="status-icon"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        className={cn("shrink-0", className)}
        {...props}
      >
        <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill={config.color} />
        {config.icon === "check" && (
          <path
            d="M6.5 10.5L9.5 13.5L14 7.5"
            stroke="var(--background)"
            strokeWidth={1.66}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        )}
        {config.icon === "x" && (
          <path
            d="M7 7L13 13M13 7L7 13"
            stroke="var(--background)"
            strokeWidth={1.66}
            strokeLinecap="round"
            fill="none"
          />
        )}
      </svg>
    );
  }

  const outerOffset = CIRCUMFERENCE * (1 - config.percentage / 100);
  const innerOffset = INNER_CIRCUMFERENCE * (1 - config.percentage / 100);
  const spinnerDash = CIRCUMFERENCE * 0.25;
  const spinnerGap = CIRCUMFERENCE - spinnerDash;
  const hasArc = config.percentage > 0;

  return (
    <svg
      data-slot="status-icon"
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
        strokeDasharray={config.dashed ? "3 3" : undefined}
      />
      {/* Outer progress arc — hidden when thinking (replaced by spinner) */}
      {!thinking && hasArc && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          stroke={config.color}
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
          stroke={config.color}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${spinnerDash} ${spinnerGap}`}
          className="animate-spin origin-center"
        />
      )}
      {/* Inner filled circle — always visible for arc statuses */}
      {hasArc && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_PATH_RADIUS}
          stroke={config.color}
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

export { StatusIcon };
export type { StatusIconProps, StatusIconStatus };
