"use client";

import * as React from "react";
import {
  FilledStatusCircle,
  StatusDash,
  StatusRing,
} from "./status-icon-primitives";

// `aria-label` is Omitted so `label` is the single naming channel — otherwise
// an inherited `aria-label` spreads last and silently wins over `label`.
type StatusPercentageIconBaseProps = Omit<
  React.SVGAttributes<SVGSVGElement>,
  "aria-label"
> & {
  /** Icon size in pixels (default 16) */
  size?: 16 | 20;
};

/**
 * `value: number | null` is the single source of truth for what to render:
 *
 * - a number (0-100) is a real completion percentage — a solid ring, or a
 *   filled check at 100%.
 * - `null` is the empty population: there is nothing to complete, which is NOT
 *   the same as 0% complete. It renders a `StatusDash` (a muted dash in the
 *   ring's slot) instead of a ring, because a ring of any texture claims a
 *   denominator this state does not have.
 *
 * ISS-4835/ISS-4812: the empty case previously reused the shipped `dashed`
 * backlog track. That put the exact Backlog-issue glyph on a project row of the
 * same table, and at 16px a dashed ring and a solid one are one texture step
 * apart, so neither the empty-vs-Backlog nor the empty-vs-0% pair separated at
 * a glance. The dash separates from both by silhouette, which survives 16px.
 *
 * Modelling both facts in one prop makes the contradictory combinations that a
 * separate `empty` boolean allowed (`empty` with `value={80}`, or an empty
 * caller that forgets the flag) unexpressible.
 *
 * The empty variant *requires* `label`: the ring is generic and only the caller
 * knows what the population is, so there is no honest default sentence to fall
 * back to — an omitted label is a type error, not a placeholder.
 */
type StatusPercentageIconProps =
  | (StatusPercentageIconBaseProps & {
      value: number;
      /** Show spinning arc for AI/agent processing. Ignored at 100% (complete). */
      thinking?: boolean;
      /**
       * Accessible name for the icon. Defaults to "N% complete". Pass the
       * caller's own sentence when the percentage summarizes a named
       * population, so the screen-reader name says what the number is a
       * percentage *of* — the only channel for that on a non-focusable,
       * tooltip-only trigger.
       */
      label?: string;
    })
  | (StatusPercentageIconBaseProps & {
      value: null;
      thinking?: never;
      /** Required for the empty population — names what is empty. */
      label: string;
    });

function StatusPercentageIcon(props: StatusPercentageIconProps) {
  // Empty population is neither 0% nor 100% — short-circuit before any
  // clamp/threshold math so it can never fall into the filled-complete path.
  if (props.value === null) {
    const { value: _value, size = 16, className, label, ...rest } = props;
    return (
      <StatusDash
        className={className}
        data-slot="status-percentage-icon"
        label={label}
        size={size}
        {...rest}
      />
    );
  }

  const {
    value,
    size = 16,
    className,
    label,
    thinking = false,
    ...rest
  } = props;
  const clamped = Math.max(0, Math.min(100, value));
  const resolvedLabel = label ?? `${Math.round(clamped)}% complete`;

  if (clamped >= 100) {
    return (
      <FilledStatusCircle
        className={className}
        data-slot="status-percentage-icon"
        fill="var(--success)"
        glyph="check"
        label={resolvedLabel}
        size={size}
        {...rest}
      />
    );
  }

  return (
    <StatusRing
      className={className}
      color="var(--progress-foreground)"
      data-slot="status-percentage-icon"
      label={resolvedLabel}
      percentage={clamped}
      size={size}
      thinking={thinking}
      {...rest}
    />
  );
}

export { StatusPercentageIcon };
export type { StatusPercentageIconProps };
