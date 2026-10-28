import {
  ensureDate,
  formatDate,
  formatDateTime,
} from "@repo/app/shared/lib/date-utils";

/** Formats nullable or invalid session timestamps into a user-safe label. */
export function safeFormatDateTime(
  date: Date | string | null | undefined
): string {
  if (!date) {
    return "Unknown";
  }
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return formatDateTime(parsed);
}

export function normalizeDateTimeString(
  date: Date | string | null | undefined
): string {
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return parsed.toISOString();
}

/** The event timeline's LOCAL calendar-day bucket key. */
export function getLocalCalendarDateKey(date: Date | null): string {
  if (!date) {
    return "unknown";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The event timeline's per-group heading for a LOCAL calendar day. */
export function formatLocalCalendarGroupTitle(date: Date | null): string {
  if (!date) {
    return "Unknown";
  }
  return formatDate(date);
}
