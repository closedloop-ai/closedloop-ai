"use client";

import * as React from "react";
import { cn } from "@repo/design-system/lib/utils";
import {
  CENTER,
  CIRCUMFERENCE,
  FilledCheckCircle,
  FilledXCircle,
  INNER_CIRCUMFERENCE,
  INNER_PATH_RADIUS,
  INNER_STROKE_WIDTH,
  RADIUS,
  STROKE_WIDTH,
} from "./status-icon-shared";

type StatusIconStatus =
  | "backlog"
  | "todo"
  | "started"
  | "in-progress"
  | "in-review"
  | "executed"
  | "complete"
  | "wont-do";

interface StatusIconProps
  extends React.SVGAttributes<SVGSVGElement> {
  /** Named phase status */
  status: StatusIconStatus;
  /** Icon size in pixels (default 16) */
  size?: 16 | 20;
  /** Show spinning arc for AI/agent processing. Only applies to non-terminal statuses (backlog, todo, in-progress, in-review); ignored for complete and wont-do. */
  thinking?: boolean;
}

const STATUS_LABELS: Record<StatusIconStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  started: "In Progress",
  "in-progress": "In progress",
  "in-review": "In review",
  executed: "Executed",
  complete: "Complete",
  "wont-do": "Won't do",
};

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
    case "started": {
      return { percentage: 25, color: "var(--progress-foreground)", dashed: false, filled: false, icon: null };
    }
    case "in-progress": {
      return { percentage: 48.5, color: "var(--progress-foreground)", dashed: false, filled: false, icon: null };
    }
    case "in-review": {
      return { percentage: 73.5, color: "var(--progress-foreground)", dashed: false, filled: false, icon: null };
    }
    case "executed": {
      return { percentage: 100, color: "var(--progress-foreground)", dashed: false, filled: false, icon: null };
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

  const defaultLabel = STATUS_LABELS[status];

  if (config.filled) {
    return (
      <svg
        role="img"
        aria-label={defaultLabel}
        data-slot="status-icon"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        className={cn("shrink-0", className)}
        {...props}
      >
        {config.icon === "check" && <FilledCheckCircle fill={config.color} />}
        {config.icon === "x" && <FilledXCircle fill={config.color} />}
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
      role="img"
      aria-label={defaultLabel}
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
          stroke="var(--thinking)"
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
