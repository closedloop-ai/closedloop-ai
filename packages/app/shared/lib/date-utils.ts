import { DATE_ONLY_REGEX } from "@repo/api/src/constants";
import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  format,
  parseISO,
} from "date-fns";

/**
 * Parse a date string as a local date (no timezone shift).
 * Handles date-only strings like "2026-03-12" correctly by treating them
 * as local dates instead of UTC dates.
 */
export function parseDateLocal(dateString: string): Date {
  // If it's a date-only string (YYYY-MM-DD), parse as local date
  if (DATE_ONLY_REGEX.test(dateString)) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  // Otherwise use parseISO for full ISO strings
  return parseISO(dateString);
}

/**
 * Ensure a value is a Date object.
 * Handles both string dates and Date objects.
 * Returns null if input is null/undefined.
 */
export function ensureDate(
  date: Date | string | null | undefined
): Date | null {
  if (!date) {
    return null;
  }
  return typeof date === "string" ? parseDateLocal(date) : date;
}

/**
 * Ensure a value is a Date object, throwing if null/undefined.
 * Use this when you know the date is present.
 */
function ensureDateRequired(date: Date | string): Date {
  return typeof date === "string" ? parseDateLocal(date) : date;
}

/**
 * Format a timestamp as a relative label from the viewer's local clock, falling
 * back to the viewer-local absolute date once the timestamp is outside the
 * short relative window.
 */
export function formatRelativeTime(
  date: Date | string,
  options: { now?: Date | number } = {}
): string {
  const dateObj = ensureDateRequired(date);
  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now ?? Date.now());
  if (dateObj.getTime() > now.getTime()) {
    return formatFutureRelativeTime(dateObj, now);
  }

  const minutes = differenceInMinutes(now, dateObj);

  if (minutes < 1) {
    return "Just now";
  }
  if (minutes === 1) {
    return "1 min ago";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = differenceInHours(now, dateObj);
  if (hours === 1) {
    return "1 hour ago";
  }
  if (hours < 24) {
    return `${hours} hours ago`;
  }

  const days = differenceInDays(now, dateObj);
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }

  return formatDate(dateObj);
}

/**
 * Format an untrusted timestamp as a relative label without throwing.
 * Invalid values degrade to the supplied fallback, or the original non-empty
 * string, so persisted session rows with missing timestamps remain renderable.
 */
export function formatRelativeTimeOrFallback(
  date: Date | string | null | undefined,
  options: { fallback?: string; now?: Date | number } = {}
): string {
  const parsed = ensureDate(date);
  if (!(parsed && isValidDate(parsed))) {
    return fallbackTimestampLabel(date, options.fallback);
  }
  return formatRelativeTime(parsed, { now: options.now });
}

/**
 * Format a timestamp as a viewer-local short date (e.g., "Jan 14, 2026").
 */
export function formatDate(date: Date | string): string {
  return format(ensureDateRequired(date), "MMM d, yyyy");
}

/**
 * Format a timestamp as a compact viewer-local date (e.g., "1/14/26").
 */
export function formatDateCompact(date: Date | string): string {
  return format(ensureDateRequired(date), "M/d/yy");
}

/**
 * Format a timestamp as a viewer-local date and time
 * (e.g., "Jan 14, 2026 at 3:30 PM").
 */
export function formatDateTime(date: Date | string): string {
  return format(ensureDateRequired(date), "MMM d, yyyy 'at' h:mm a");
}

/**
 * Format an untrusted timestamp as a viewer-local date and time without
 * throwing. Invalid values degrade to the supplied fallback, or the original
 * non-empty string, for parity with legacy UI formatters.
 */
export function formatDateTimeOrFallback(
  date: Date | string | null | undefined,
  options: { fallback?: string } = {}
): string {
  const parsed = ensureDate(date);
  if (!(parsed && isValidDate(parsed))) {
    return fallbackTimestampLabel(date, options.fallback);
  }
  return formatDateTime(parsed);
}

/**
 * Format a timestamp as viewer-local time. Seconds are omitted by default and
 * included as two digits only when explicitly requested by diagnostic views.
 */
export function formatTime(
  date: Date | string,
  options: { includeSeconds?: boolean; hour12?: boolean } = {}
): string {
  return format(ensureDateRequired(date), timeFormatPattern(options));
}

/**
 * Format an untrusted timestamp as viewer-local time without throwing.
 * Invalid values degrade to the supplied fallback, or the original non-empty
 * string, so render paths fed by persisted rows or streams remain resilient.
 */
export function formatTimeOrFallback(
  date: Date | string | null | undefined,
  options: {
    includeSeconds?: boolean;
    fallback?: string;
    hour12?: boolean;
  } = {}
): string {
  const parsed = ensureDate(date);
  if (!(parsed && isValidDate(parsed))) {
    return fallbackTimestampLabel(date, options.fallback);
  }
  return formatTime(parsed, {
    hour12: options.hour12,
    includeSeconds: options.includeSeconds,
  });
}

/**
 * Format a local calendar date as an ISO date string for forms/inputs.
 */
export function formatDateForInput(date: Date | string): string {
  return format(ensureDateRequired(date), "yyyy-MM-dd");
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function fallbackTimestampLabel(
  date: Date | string | null | undefined,
  fallback?: string
): string {
  if (fallback !== undefined) {
    return fallback;
  }
  return typeof date === "string" && date.trim() ? date : "-";
}

function formatFutureRelativeTime(dateObj: Date, now: Date): string {
  const minutes = differenceInMinutes(dateObj, now);

  if (minutes < 1) {
    return "Just now";
  }
  if (minutes === 1) {
    return "1 min from now";
  }
  if (minutes < 60) {
    return `${minutes} min from now`;
  }

  const hours = differenceInHours(dateObj, now);
  if (hours === 1) {
    return "1 hour from now";
  }
  if (hours < 24) {
    return `${hours} hours from now`;
  }

  const days = differenceInDays(dateObj, now);
  if (days === 1) {
    return "Tomorrow";
  }
  if (days < 7) {
    return `${days} days from now`;
  }

  return formatDate(dateObj);
}

function timeFormatPattern(options: {
  includeSeconds?: boolean;
  hour12?: boolean;
}): string {
  if (options.hour12 === false) {
    return options.includeSeconds ? "HH:mm:ss" : "HH:mm";
  }
  return options.includeSeconds ? "h:mm:ss a" : "h:mm a";
}
