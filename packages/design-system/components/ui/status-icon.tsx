"use client";

import * as React from "react";
import {
  FilledStatusCircle,
  type StatusGlyph,
  StatusRing,
} from "./status-icon-primitives";

type StatusIconStatus =
  | "backlog"
  | "todo"
  | "started"
  | "in-progress"
  | "in-review"
  | "executed"
  | "complete"
  | "wont-do"
  | "decorative";

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
  decorative: "Status",
};

type StatusConfig = {
  percentage: number;
  color: string;
  dashed: boolean;
  glyph?: StatusGlyph;
  /** Override the track (background circle) color. Defaults to var(--progress). */
  trackColor?: string;
  /** Override the ring track/arc stroke width. Defaults to STROKE_WIDTH (2). */
  ringStrokeWidth?: number;
};

function getStatusConfig(status: StatusIconStatus): StatusConfig {
  switch (status) {
    case "backlog": {
      return { percentage: 0, color: "var(--progress)", dashed: true };
    }
    case "todo": {
      return { percentage: 0, color: "var(--progress)", dashed: false };
    }
    case "started": {
      return {
        percentage: 25,
        color: "var(--progress-foreground)",
        dashed: false,
      };
    }
    case "in-progress": {
      return {
        percentage: 48.5,
        color: "var(--progress-foreground)",
        dashed: false,
      };
    }
    case "in-review": {
      return {
        percentage: 73.5,
        color: "var(--progress-foreground)",
        dashed: false,
      };
    }
    case "executed": {
      return {
        percentage: 100,
        color: "var(--progress-foreground)",
        dashed: false,
      };
    }
    case "complete": {
      return {
        percentage: 100,
        color: "var(--success)",
        dashed: false,
        glyph: "check",
      };
    }
    case "wont-do": {
      return {
        percentage: 100,
        color: "var(--foreground)",
        dashed: false,
        glyph: "x",
      };
    }
    default: {
      // "decorative" plus the unknown-status fallback. Matches the visual
      // for decorative icons so that an unrecognized status renders as a
      // muted neutral marker rather than an empty "todo" circle.
      return {
        percentage: 48.5,
        color: "var(--muted-foreground)",
        dashed: false,
        trackColor: "var(--muted-foreground)",
        ringStrokeWidth: 1.5,
      };
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

  if (config.glyph) {
    return (
      <FilledStatusCircle
        aria-label={defaultLabel}
        className={className}
        fill={config.color}
        glyph={config.glyph}
        label={defaultLabel}
        size={size}
        {...props}
      />
    );
  }

  return (
    <StatusRing
      aria-label={defaultLabel}
      className={className}
      color={config.color}
      dashed={config.dashed}
      label={defaultLabel}
      percentage={config.percentage}
      ringStrokeWidth={config.ringStrokeWidth}
      size={size}
      thinking={thinking}
      trackColor={config.trackColor}
      {...props}
    />
  );
}

export { StatusIcon };
export type { StatusIconProps, StatusIconStatus };
