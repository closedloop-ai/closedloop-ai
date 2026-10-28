/**
 * When a compute target was last seen, as an absolute local date and time.
 *
 * Absolute rather than relative on purpose: the number beside it is a device's
 * liveness, and "3 days ago" reads as an estimate where an exact stamp reads as
 * a record. `Unknown` for an unparseable date — never a plausible default, and
 * never the epoch.
 *
 * Lives in `packages/app` (moved from `apps/app/…/settings/format-last-seen.ts`,
 * PLN-1915 Step 5) because `ComputeTargetRow` renders this subtitle for both
 * the legacy Settings card and the Settings v2 panel.
 */
export function formatLastSeen(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
