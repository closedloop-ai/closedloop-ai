/**
 * Shared IANA timezone-aware date-only (YYYY-MM-DD) formatting.
 *
 * Constructing `Intl.DateTimeFormat` is the expensive part of Intl, and callers
 * such as the CSV export (one call per row) and the Insights daily-chart
 * bucketing (one call per bucket) reuse the same zone repeatedly — cache one
 * formatter per timezone. Invalid timezones cache `null` so the failed
 * construction isn't retried per call. Bounded: there are only ~430 IANA zone
 * names.
 */
const dateOnlyFormatters = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Return a cached `Intl.DateTimeFormat("en-CA", …)` for the given IANA
 * timezone, or `null` if the timezone is invalid. The `en-CA` locale with
 * 2-digit month/day emits `YYYY-MM-DD` output.
 */
export function getDateOnlyFormatter(
  timeZone: string
): Intl.DateTimeFormat | null {
  const cached = dateOnlyFormatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = null;
  }
  dateOnlyFormatters.set(timeZone, formatter);
  return formatter;
}

/** Format a Date as a UTC ISO date string (YYYY-MM-DD). */
export function toIsoDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * FEA-1459: Format a Date as an ISO date string (YYYY-MM-DD) in the given IANA
 * timezone. Falls back to UTC (toIsoDateOnly) if the timezone is
 * null/undefined or invalid.
 */
export function toLocalDateOnly(
  value: Date,
  timeZone: string | null | undefined
): string {
  if (!timeZone) {
    return toIsoDateOnly(value);
  }
  const formatter = getDateOnlyFormatter(timeZone);
  if (!formatter) {
    return toIsoDateOnly(value);
  }
  return formatter.format(value);
}

/**
 * Whether the given string is a valid IANA timezone, decided by whether the
 * shared date-only formatter could be constructed for it (reusing the
 * per-timezone cache above). Used to reject unknown/malformed zones before
 * bucketing so the caller can fall back to UTC.
 */
export function isValidTimeZone(timeZone: string): boolean {
  return getDateOnlyFormatter(timeZone) !== null;
}

// `Intl.DateTimeFormat` accepts offset-style zone identifiers (`+01:00`,
// `-0500`, `+01`) in addition to IANA names. These are dangerous to pass to
// PostgreSQL's `AT TIME ZONE 'text'` operator: PG interprets a bare offset
// string with POSIX sign semantics that are inverted from ISO 8601, so
// `AT TIME ZONE '+01:00'` shifts the opposite direction from `Intl`, bucketing
// event-volume rows onto the wrong local day (FEA-2881 review). Matches the
// `±HH`, `±HHMM`, `±HH:MM` forms `Intl` accepts.
const OFFSET_TIME_ZONE_PATTERN = /^([+-])(\d{2}):?(\d{2})?$/;

/**
 * Canonicalize a timezone identifier into a form both `Intl` and PostgreSQL's
 * `AT TIME ZONE` operator interpret identically, so JS-side day-key labeling
 * (`toLocalDateOnly`) and SQL-side `date_trunc` bucketing agree.
 *
 * IANA names (`America/New_York`, `Etc/GMT+5`, `UTC`) are returned unchanged —
 * PG and `Intl` already agree on those. Offset-style identifiers (`+01:00`),
 * which `Intl` accepts but PG mis-signs, are rewritten to their equivalent
 * whole-hour `Etc/GMT±N` IANA name; note the `Etc/GMT` sign is INVERTED from the
 * offset (UTC+1 → `Etc/GMT-1`, UTC-5 → `Etc/GMT+5`). Offsets that cannot be
 * expressed as a whole-hour `Etc/GMT` zone (non-zero minutes such as `+05:30`,
 * or out of the `-14`…`+12` range) and any otherwise-invalid identifier return
 * `null`, so callers fall back to UTC bucketing rather than risk wrong buckets.
 */
export function canonicalizeTimeZone(timeZone: string): string | null {
  if (!isValidTimeZone(timeZone)) {
    return null;
  }
  const offsetMatch = OFFSET_TIME_ZONE_PATTERN.exec(timeZone);
  if (!offsetMatch) {
    // A real IANA name (including `Etc/GMT±N`); PG and Intl already agree.
    return timeZone;
  }
  const [, sign, hoursText, minutesText] = offsetMatch;
  if (minutesText && minutesText !== "00") {
    // Whole-hour Etc/GMT zones can't represent a fractional offset; fall back.
    return null;
  }
  const hours = Number.parseInt(hoursText, 10);
  if (hours === 0) {
    return "UTC";
  }
  // Etc/GMT signs are inverted from the offset: UTC+H is Etc/GMT-H.
  const invertedSign = sign === "+" ? "-" : "+";
  const etcZone = `Etc/GMT${invertedSign}${hours}`;
  // Etc/GMT only defines -14…+12; validate before trusting it.
  return isValidTimeZone(etcZone) ? etcZone : null;
}
