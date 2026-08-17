/**
 * @file format.ts
 * @description Pure formatting helpers for the session-limit UI. `now` is an
 * explicit parameter (not `Date.now()` inside) so the components stay
 * deterministically testable.
 */

// Use the canonical percentage clamp (non-finite → 0) from `@repo/api` rather
// than re-deriving it here; consumers that need it import it directly.
import { clampPercent } from "@repo/api/src/utils/math";
import type { SessionLimitSource } from "../types";

/**
 * "42% used" from a utilization value (floored, like the CLI's display), or
 * null when the value is not a real measurement.
 *
 * A non-finite utilization returns null rather than "0% used". Clamping it to
 * zero would print a measured-looking figure for a number we never measured —
 * the fabricated-zero failure this feature exists to avoid — and types do not
 * constrain what arrives over the IPC boundary, so this is reachable. Negatives
 * do clamp to zero, matching `Progress`'s documented safe under-claim.
 */
export function formatUsedLabel(utilization: number): string | null {
  if (!Number.isFinite(utilization)) {
    return null;
  }
  return `${Math.floor(clampPercent(utilization))}% used`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Epoch-ms for an ISO timestamp, or null when missing/unparseable. */
function parseTimestampMs(iso: string | null): number | null {
  if (!iso) {
    return null;
  }
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

type RelativeDeltaOptions = {
  /**
   * Label for a sub-minute magnitude (the reset label collapses this into its
   * `now` boundary and never reaches here; the fetched label uses "just now").
   */
  subMinute: string;
  /** Wraps the compact `{n}m|h|d` magnitude, e.g. `(n) => \`in ${n}\``. */
  wrap: (compact: string) => string;
};

/**
 * The one tiered relative-time formatter behind {@link formatResetLabel} and
 * {@link formatFetchedAtLabel}: turns a non-negative delta into a compact
 * minutes/hours/days magnitude (`45m`, `3h`, `2d`) and defers direction/wording
 * to the caller's {@link RelativeDeltaOptions}. Sub-minute deltas yield
 * `subMinute`; minutes round to at least 1 so a just-over-boundary delta never
 * reads as `0m`.
 */
function formatRelativeDelta(
  deltaMs: number,
  { subMinute, wrap }: RelativeDeltaOptions
): string {
  if (deltaMs < MINUTE_MS) {
    return subMinute;
  }
  if (deltaMs < HOUR_MS) {
    return wrap(`${Math.max(1, Math.round(deltaMs / MINUTE_MS))}m`);
  }
  if (deltaMs < DAY_MS) {
    return wrap(`${Math.round(deltaMs / HOUR_MS)}h`);
  }
  return wrap(`${Math.round(deltaMs / DAY_MS)}d`);
}

/**
 * Compact relative reset label: "now", "in 45m", "in 3h", "in 2d". Returns null
 * for a missing/unparseable timestamp so callers can omit the "Resets …" line.
 */
export function formatResetLabel(
  resetsAt: string | null,
  now: Date = new Date()
): string | null {
  const resetMs = parseTimestampMs(resetsAt);
  if (resetMs === null) {
    return null;
  }
  const deltaMs = resetMs - now.getTime();
  if (deltaMs <= 0) {
    return "now";
  }
  // Sub-minute future resets read as "in 1m" (rounded up), not "now".
  return formatRelativeDelta(deltaMs, {
    subMinute: "in 1m",
    wrap: (compact) => `in ${compact}`,
  });
}

/** "$3.50 of $20.00" style credit summary; null when either value is unknown. */
export function formatCreditSummary(
  usedUsd: number | null,
  limitUsd: number | null
): string | null {
  if (usedUsd === null) {
    return null;
  }
  const used = `$${usedUsd.toFixed(2)}`;
  if (limitUsd === null) {
    return `${used} used`;
  }
  return `${used} of $${limitUsd.toFixed(2)}`;
}

/**
 * Human label for the snapshot's producer, for the detail drawer's provenance
 * line. Exhaustive over {@link SessionLimitSource}; a null/unknown source yields
 * null so the caller omits the label rather than showing a raw literal.
 */
export function formatSourceLabel(
  source: SessionLimitSource | null | undefined
): string | null {
  if (source === null || source === undefined) {
    return null;
  }
  switch (source) {
    case "usage_api":
      return "Usage endpoint";
    case "statusline":
      return "Statusline";
    case "rate_limit_event":
      return "Rate-limit event";
    default: {
      // Exhaustive over `SessionLimitSource`: a new producer variant must add a
      // label here rather than silently rendering nothing (CLAUDE.md
      // exhaustiveness rule; the desktop twin union is compile-guarded in
      // types.ts so the two source unions cannot drift).
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/**
 * Compact relative "fetched" label: "just now", "1m ago", "3h ago", "2d ago".
 * Returns null for a missing/unparseable timestamp so callers can omit the
 * provenance line. A future timestamp (clock skew) reads as "just now".
 */
export function formatFetchedAtLabel(
  fetchedAt: string | null,
  now: Date = new Date()
): string | null {
  const fetchedMs = parseTimestampMs(fetchedAt);
  if (fetchedMs === null) {
    return null;
  }
  // A future timestamp (clock skew) yields a negative delta → sub-minute →
  // "just now".
  const deltaMs = now.getTime() - fetchedMs;
  return formatRelativeDelta(deltaMs, {
    subMinute: "just now",
    wrap: (compact) => `${compact} ago`,
  });
}

/**
 * A timestamp rendered as an actual date and time the user can read, e.g.
 * "Jul 19, 3:00 PM". Returns null for a missing/unparseable value.
 *
 * PRD-538 R6 requires this alongside the relative labels: "in 3h" is a duration,
 * not a time, and it is unusable for anyone deciding when to come back — it also
 * silently goes wrong the moment the page has been open a while. The relative
 * label stays as the scannable summary; this is the fact behind it.
 *
 * `timeZone` is injectable purely so tests are not hostage to the runner's TZ;
 * production callers omit it and get the user's own zone.
 */
export function formatAbsoluteDateTime(
  iso: string | null | undefined,
  timeZone?: string
): string | null {
  const ms = parseTimestampMs(iso ?? null);
  if (ms === null) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

/**
 * The value for a `<time dateTime={…}>` attribute: the timestamp normalized to
 * ISO-8601, or null when it cannot be parsed. Machine-readable half of the
 * "real datetime, not only a relative string" requirement — assistive tech and
 * the DOM get an unambiguous instant even where the visible text is relative.
 */
/**
 * The one wording for "these figures are from then, not from now", shared by the
 * sidebar caveat and the drawer's provenance footer so the same fact is not
 * stated two different ways in two places.
 *
 * It says only when the snapshot was taken. An earlier draft added "not
 * updating", which described the mechanism rather than the consequence and read
 * like an error the user was expected to act on; the age is the whole message.
 */
export function formatStaleAsOfLabel(
  fetchedAt: string | null | undefined,
  timeZone?: string
): string | null {
  const absolute = formatAbsoluteDateTime(fetchedAt, timeZone);
  return absolute === null ? null : `As of ${absolute}`;
}

export function toDateTimeAttribute(
  iso: string | null | undefined
): string | null {
  const ms = parseTimestampMs(iso ?? null);
  return ms === null ? null : new Date(ms).toISOString();
}
