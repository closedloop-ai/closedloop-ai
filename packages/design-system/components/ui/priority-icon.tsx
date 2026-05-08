"use client";

import * as React from "react";
import { cn } from "@repo/design-system/lib/utils";

type PriorityLevel = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface PriorityIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** The priority level to render */
  priority: PriorityLevel;
  /** Icon size in pixels (default 16) */
  size?: number;
}

function PriorityIcon({
  priority,
  size = 16,
  className,
  ...props
}: PriorityIconProps) {
  if (priority === "URGENT") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={cn("shrink-0", className)}
        {...props}
      >
        <rect
          x={1}
          y={0}
          width={14}
          height={16}
          rx={1.5}
          fill="currentColor"
        />
        <rect
          x={7}
          y={3}
          width={2}
          height={7}
          rx={1}
          style={{ fill: "var(--background, #fff)" }}
        />
        <rect
          x={7}
          y={11.5}
          width={2}
          height={2}
          rx={1}
          style={{ fill: "var(--background, #fff)" }}
        />
      </svg>
    );
  }

  // Signal bars: LOW = 1 active, MEDIUM = 2 active, HIGH = 3 active
  const activeCount = ACTIVE_BAR_COUNT[priority] ?? 3;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("shrink-0", className)}
      {...props}
    >
      <rect
        x={1}
        y={10}
        width={3}
        height={6}
        rx={1.5}
        fill="currentColor"
        opacity={activeCount >= 1 ? 1 : 0.3}
      />
      <rect
        x={6.5}
        y={6}
        width={3}
        height={10}
        rx={1.5}
        fill="currentColor"
        opacity={activeCount >= 2 ? 1 : 0.3}
      />
      <rect
        x={12}
        y={0}
        width={3}
        height={16}
        rx={1.5}
        fill="currentColor"
        opacity={activeCount >= 3 ? 1 : 0.3}
      />
    </svg>
  );
}

const ACTIVE_BAR_COUNT: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

export { PriorityIcon };
export type { PriorityIconProps, PriorityLevel };
