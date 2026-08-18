import { selectSummaryBars } from "../lib/summary-bars";
import type { SessionLimits } from "../types";
import { LimitBar } from "./limit-bar";

export type SessionLimitsBarsProps = {
  limits: SessionLimits;
  now?: Date;
  /** Injectable time zone so tests are not hostage to the runner's TZ. */
  timeZone?: string;
};

/**
 * The compact two-bar summary for the sidebar footer: "Current session"
 * (5-hour) and "Current week" (7-day, all models), or the one window a
 * subset-window plan does expose.
 *
 * Which windows those are is decided by {@link selectSummaryBars}, shared with
 * the nav trigger's accessible name so the announced figures and the drawn ones
 * cannot drift.
 */
export function SessionLimitsBars({
  limits,
  now,
  timeZone,
}: SessionLimitsBarsProps) {
  const bars = selectSummaryBars(limits);
  if (bars.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="session-limits-bars">
      {bars.map((bar) => (
        <LimitBar
          key={bar.title}
          limit={bar.limit}
          now={now}
          timeZone={timeZone}
          title={bar.title}
        />
      ))}
    </div>
  );
}
