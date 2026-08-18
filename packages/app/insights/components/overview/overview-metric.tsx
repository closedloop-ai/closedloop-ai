"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * One headline figure inside an overview roll-up card: uppercase label, large
 * value, muted caption.
 *
 * Extracted from `AiImpactCard`, which invented this treatment, so a second
 * metric added to that grid inherits the typography instead of re-declaring it.
 * Two metrics side by side rendering the same idea from two copies of the same
 * class strings is how a row starts to look almost-aligned.
 *
 * Presentational only — the caller has already decided what the value reads as,
 * including whether it is a real number or the honest no-value glyph. That
 * decision belongs to the metric's owner, not to its typography.
 */
export function OverviewMetric({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  /** Already formatted. Pass the no-value glyph rather than a fabricated 0. */
  value: string;
  detail: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
        {label}
      </p>
      <p
        className="truncate font-semibold text-2xl tracking-tight"
        title={value}
      >
        {value}
      </p>
      <p className="text-muted-foreground text-sm">{detail}</p>
    </div>
  );
}
