"use client";

import { cn } from "@repo/design-system/lib/utils";

/**
 * The per-row outcome badge for System Check.
 *
 * Shared by the check rows in `system-check-results.tsx` and the Repair panel's
 * step list (ISS-5389) so a repair step's "fixed" and a plugin row's "Enabled"
 * cannot drift into two different treatments. The badge carries its weight
 * through tint, border, and font weight rather than size, which is what lets it
 * sit at the end of a `text-sm` row without competing with the row's label.
 */

export const SystemCheckStatusTone = {
  Success: "success",
  Warning: "warning",
  Danger: "danger",
  Neutral: "neutral",
} as const;

export type SystemCheckStatusTone =
  (typeof SystemCheckStatusTone)[keyof typeof SystemCheckStatusTone];

export type SystemCheckStatusBadgeProps = {
  label: string;
  tone: SystemCheckStatusTone;
  className?: string;
};

export function SystemCheckStatusBadge({
  label,
  tone,
  className,
}: Readonly<SystemCheckStatusBadgeProps>) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 font-medium text-[10px]",
        TONE_CLASS_NAMES[tone],
        className
      )}
    >
      {label}
    </span>
  );
}

const TONE_CLASS_NAMES: Record<SystemCheckStatusTone, string> = {
  [SystemCheckStatusTone.Success]:
    "border-success/30 bg-success/10 text-success",
  [SystemCheckStatusTone.Warning]:
    "border-warning/30 bg-warning/10 text-warning-foreground",
  [SystemCheckStatusTone.Danger]:
    "border-destructive/30 bg-destructive/10 text-destructive",
  [SystemCheckStatusTone.Neutral]:
    "border-border bg-muted text-muted-foreground",
};
