import { Skeleton } from "@repo/design-system/components/ui/skeleton";

/**
 * The "not yet fetched" affordance for the sidebar summary (PRD-538 R6).
 *
 * This exists so loading cannot be drawn as a zero. Two empty `Progress` tracks
 * would be indistinguishable from a real 0% — a lying UI, and the exact failure
 * this ticket names — so the placeholder is a skeleton, which reads as absent
 * data rather than as a measured value. It carries no percentage text for the
 * same reason: there is no percentage yet.
 *
 * `aria-busy` plus a live status makes the wait legible to a screen reader
 * instead of a silent empty region.
 */
export function SessionLimitsLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-2"
      data-testid="session-limits-loading"
      role="status"
    >
      <span className="sr-only">Loading session limits</span>
      {["current-session", "current-week"].map((slot) => (
        <div className="flex flex-col gap-1" key={slot}>
          {/* Each row is the line box of the row it resolves into, not a
              generic bar: h-4 for the `text-xs` title line, h-2 for the
              `Progress` track itself, h-3 for the smaller "Resets …" line.
              Shorter placeholders made the block grow as it resolved, which is
              the jump this component exists to prevent. The gaps match too —
              `gap-1` inside a bar, `gap-2` between them, the same rhythm
              LimitBar and SessionLimitsBars use. */}
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
