import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  format,
  parseISO,
} from "date-fns";

// Regex for date-only strings (YYYY-MM-DD)
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
 * Ensure a value is a Date object
 */
function ensureDate(date: Date | string): Date {
  return typeof date === "string" ? parseDateLocal(date) : date;
}

/**
 * Format a date as a relative time string (e.g., "Just now", "5 min ago", "2 hours ago")
 */
export function formatRelativeTime(date: Date | string): string {
  const dateObj = ensureDate(date);
  const now = new Date();
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

  return format(dateObj, "MMM d, yyyy");
}

/**
 * Format a date as a short date string (e.g., "Jan 14, 2026")
 */
export function formatDate(date: Date | string): string {
  return format(ensureDate(date), "MMM d, yyyy");
}

/**
 * Format a date as a compact date string (e.g., "1/14/26")
 */
export function formatDateCompact(date: Date | string): string {
  return format(ensureDate(date), "M/d/yy");
}

/**
 * Format a date with time (e.g., "Jan 14, 2026 at 3:30 PM")
 */
export function formatDateTime(date: Date | string): string {
  return format(ensureDate(date), "MMM d, yyyy 'at' h:mm a");
}

/**
 * Format a date as ISO string for forms/inputs
 */
export function formatDateForInput(date: Date | string): string {
  return format(ensureDate(date), "yyyy-MM-dd");
}
