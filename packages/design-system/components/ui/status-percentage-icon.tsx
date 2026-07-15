"use client";

import * as React from "react";
import {
  FilledStatusCircle,
  StatusRing,
} from "./status-icon-primitives";

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
      <FilledStatusCircle
        aria-label={defaultLabel}
        className={className}
        data-slot="status-percentage-icon"
        fill="var(--success)"
        glyph="check"
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
      color="var(--progress-foreground)"
      data-slot="status-percentage-icon"
      label={defaultLabel}
      percentage={clamped}
      size={size}
      thinking={thinking}
      {...props}
    />
  );
}

export { StatusPercentageIcon };
export type { StatusPercentageIconProps };
