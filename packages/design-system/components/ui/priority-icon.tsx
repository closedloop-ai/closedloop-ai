"use client";

import * as React from "react";
import type { PriorityValue } from "@closedloop-ai/design-system/lib/priority-order";
import { cn } from "@closedloop-ai/design-system/lib/utils";

type PriorityLevel = PriorityValue;

interface PriorityIconProps extends React.SVGAttributes<SVGSVGElement> {
  /**
   * The priority to render. Takes any string, like `priorityLabel` and
   * `priorityRank` in the same module and for the same reason: the value arrives
   * from a wire payload or a persisted filter, so a member only a newer peer
   * knows reaches this component at runtime. The signal-bar fallback below has
   * always handled that case; typing this `PriorityValue` made the handling
   * unreachable and pushed callers into suppressing the glyph instead.
   */
  priority: string;
  /** Icon size in pixels (default 16) */
  size?: number;
}

/**
 * `data-slot` follows the house convention across these primitives, and it is
 * the stable hook a consumer needs to find every glyph this component painted
 * without reaching for the element shape.
 */
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
        viewBox="-2 -2 20 20"
        fill="none"
        className={cn("shrink-0", className)}
        data-slot="priority-icon"
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
  const activeCount = ACTIVE_BARS.get(priority) ?? 3;

  return (
    <svg
      width={size}
      height={size}
      viewBox="-2 -2 20 20"
      fill="none"
      className={cn("shrink-0", className)}
      data-slot="priority-icon"
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

// Exhaustive but for URGENT, which returns its own glyph above, so a new value
// fails typecheck.
const ACTIVE_BAR_COUNT: Readonly<
  Record<Exclude<PriorityValue, "URGENT">, number>
> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * The same table, string-keyed, so a wire value can be looked up without a cast
 * and without widening the declaration above out of exhaustiveness. A `Map`
 * rather than the object itself so an untrusted key cannot reach a prototype
 * member. The `?? 3` at the call site covers version skew: a value this build
 * does not know draws three bars rather than three faded ones.
 */
const ACTIVE_BARS: ReadonlyMap<string, number> = new Map(
  Object.entries(ACTIVE_BAR_COUNT)
);

export { PriorityIcon };
export type { PriorityIconProps, PriorityLevel };
