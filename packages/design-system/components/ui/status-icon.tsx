"use client";

import * as React from "react";
import {
  type StatusAppearance,
  StatusAppearanceIcon,
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
  | "failed"
  | "decorative";

interface StatusIconProps
  extends React.SVGAttributes<SVGSVGElement> {
  /** Named phase status */
  status: StatusIconStatus;
  /** Icon size in pixels (default 16) */
  size?: 16 | 20;
  /** Show spinning arc for AI/agent processing. Only applies to non-terminal statuses (backlog, todo, in-progress, in-review); ignored for complete, wont-do, and failed. */
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
  failed: "Failed",
  decorative: "Status",
};

/**
 * This generic phase vocabulary's mapping onto the shared appearance names. The
 * tuple each name resolves to belongs to `status-icon-primitives`.
 */
const STATUS_APPEARANCE: Record<StatusIconStatus, StatusAppearance> = {
  backlog: "dashed-ring",
  todo: "empty-ring",
  started: "quarter-ring",
  "in-progress": "half-ring",
  "in-review": "three-quarter-ring",
  executed: "full-ring",
  complete: "success-check",
  "wont-do": "foreground-x",
  failed: "destructive-bolt",
  // Also the unknown-status fallback below: an unrecognized status renders as a
  // muted marker rather than an empty "todo" circle.
  decorative: "muted-half-ring",
};

function StatusIcon({
  status,
  size = 16,
  thinking = false,
  className,
  ...props
}: StatusIconProps) {
  const knownStatus = hasStatusAppearance(status);
  const appearance = knownStatus
    ? STATUS_APPEARANCE[status]
    : "muted-half-ring";
  const label = knownStatus ? STATUS_LABELS[status] : STATUS_LABELS.decorative;

  return (
    <StatusAppearanceIcon
      appearance={appearance}
      className={className}
      label={label}
      size={size}
      thinking={thinking}
      {...props}
    />
  );
}

function hasStatusAppearance(status: string): status is StatusIconStatus {
  return Object.hasOwn(STATUS_APPEARANCE, status);
}

export { STATUS_LABELS, StatusIcon };
export type { StatusIconProps, StatusIconStatus };
