import type { CodexRateLimitWindowView } from "../components/detail/detail-content";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 60 * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const SECONDS_PER_MINUTE = 60;

/**
 * Render a whole-minute span in human units — "45m", "5h", "6d 1h", "7d" —
 * mirroring the Duration row's h/m plainness (FEA-3993). Codex's primary window
 * is hours and its secondary window is weekly, so the raw "10,080m" that minutes
 * printed nobody reads as a week; this collapses it to days/hours. Rounds to
 * whole minutes, drops zero components, and floors sub-minute spans at "0m".
 */
export function formatMinutesSpan(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m`;
  }
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const remMinutes = minutes % MINUTES_PER_HOUR;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (remMinutes > 0 && days === 0) {
    parts.push(`${remMinutes}m`);
  }
  return parts.join(" ");
}

/**
 * Name a Codex rate-limit window by its own duration so the row reads on its
 * own — "5h", "weekly" — instead of the payload's "primary"/"secondary"
 * (FEA-3993). An exact 7-day window is the recurring weekly cap, so it gets the
 * word; every other window is its h/m/d span. Returns null when the window
 * carries no duration, so the caller falls back to the generic slot name.
 */
export function formatCodexRateLimitWindowLabel(
  windowMinutes: number | null
): string | null {
  if (windowMinutes == null) {
    return null;
  }
  if (windowMinutes === MINUTES_PER_WEEK) {
    return "weekly";
  }
  return formatMinutesSpan(windowMinutes);
}

/**
 * Format a rate-limit window's VALUE as "N% used | resets in 6d 1h", omitting
 * any part whose source field is absent/malformed so the row never lies about
 * data it does not have. A missing used-percent drops the "used" fragment
 * entirely rather than emitting a bare-dash glyph, matching how the rest of
 * this panel elides missing data. The window duration itself moves to the row
 * LABEL (see {@link formatCodexRateLimitWindowLabel}), so it is not repeated
 * here. Joined with " | " to line up with every sibling row.
 *
 * `resets_at` is an ABSOLUTE Unix epoch-seconds timestamp (FEA-3524), so the
 * remaining time is computed as `resets_at - now` (clamped to >= 0) before being
 * rendered in h/m/d units — rendering the raw epoch would read as ~29 million
 * minutes, and raw minutes read badly for weekly windows. A window whose reset
 * has already elapsed renders "resets now". `nowEpochSeconds` is injected for
 * deterministic testing. `readCodexRateLimitWindow` maps an all-absent window
 * to null, so the caller never renders a row for one — hence no empty fallback.
 */
export function formatCodexRateLimitWindow(
  window: CodexRateLimitWindowView,
  nowEpochSeconds: number = Date.now() / 1000
): string {
  const parts: string[] = [];
  if (window.usedPercent != null) {
    parts.push(`${Math.round(window.usedPercent)}% used`);
  }
  if (window.resetsAtEpochSeconds != null) {
    const remainingSeconds = Math.max(
      0,
      window.resetsAtEpochSeconds - nowEpochSeconds
    );
    parts.push(
      remainingSeconds < SECONDS_PER_MINUTE
        ? "resets now"
        : `resets in ${formatMinutesSpan(remainingSeconds / SECONDS_PER_MINUTE)}`
    );
  }
  return parts.join(" | ");
}
