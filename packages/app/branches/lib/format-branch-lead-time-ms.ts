import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";

/** Formats the Branch headline lead time without changing shorter duration consumers. */
export function formatBranchLeadTimeMs(durationMs: number): string {
  if (durationMs < DAY_MS) {
    return formatDurationMs(durationMs);
  }

  const totalHours = Math.floor(durationMs / HOUR_MS);
  const days = Math.floor(totalHours / HOURS_PER_DAY);
  const hours = totalHours % HOURS_PER_DAY;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

const HOUR_MS = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
