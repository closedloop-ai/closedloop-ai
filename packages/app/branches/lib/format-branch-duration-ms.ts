import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";

const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;

/**
 * ISS-6958: the Branch detail screen's ONE duration treatment.
 *
 * `formatDurationMs` stops at minutes, so a 53-hour outcome rendered "3180m 0s"
 * — arithmetically right and unreadable. Its predecessor here
 * (`formatBranchLeadTimeMs`) only escaped that above 24h and only on one card,
 * which left every duration between an hour and a day in minutes on every
 * consumer INCLUDING that card. This scales the whole way and drops a
 * zero-valued trailing component, so the reader gets "2d 5h", not "3180m 0s"
 * and not "2d 5h 0m".
 *
 * Sub-minute values delegate unchanged: milliseconds and fractional seconds are
 * already legible, and the phase key renders genuinely tiny slices.
 *
 * Deliberately NOT a change to `formatDurationMs` itself. That one is shared
 * with Sessions, Analytics, Insights and Routines, whose surfaces this ticket
 * did not examine and whose closed-by-default gates this change does not carry.
 */
export function formatBranchDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < MINUTE_SECONDS * SECOND_MS) {
    return formatDurationMs(ms);
  }
  // Round to whole seconds BEFORE splitting, so a remainder that rounds up
  // carries into the next unit instead of rendering a 60 in a slot.
  const totalMinutes = Math.floor(Math.round(ms / SECOND_MS) / MINUTE_SECONDS);
  const seconds = Math.round(ms / SECOND_MS) % MINUTE_SECONDS;
  if (totalMinutes < HOUR_MINUTES) {
    return joinParts(`${totalMinutes}m`, seconds, "s");
  }
  const totalHours = Math.floor(totalMinutes / HOUR_MINUTES);
  if (totalHours < DAY_HOURS) {
    return joinParts(`${totalHours}h`, totalMinutes % HOUR_MINUTES, "m");
  }
  return joinParts(
    `${Math.floor(totalHours / DAY_HOURS)}d`,
    totalHours % DAY_HOURS,
    "h"
  );
}

/** Appends the finer component only when it carries information. */
function joinParts(lead: string, remainder: number, unit: string): string {
  return remainder === 0 ? lead : `${lead} ${remainder}${unit}`;
}
