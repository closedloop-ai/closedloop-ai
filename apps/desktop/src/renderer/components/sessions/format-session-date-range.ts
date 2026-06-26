import { formatDate } from "@repo/app/shared/lib/date-utils";

const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/**
 * Format the covered date range for the Sessions summary metric cards from the
 * usage summary's `earliestSessionAt` / `latestSessionAt` ISO bounds.
 *
 * - Both null (no sessions match) → null, so the caller renders no detail line.
 * - Same calendar day → a single date ("Jun 17, 2026").
 * - Same year → the year is shown once on the end ("Jun 1 – Jun 17, 2026").
 * - Spanning years → both endpoints carry their year
 *   ("Dec 30, 2025 – Jan 2, 2026").
 *
 * Unparseable/null bounds degrade to null rather than rendering "Invalid Date".
 *
 * Formatted in the viewer's local time zone so UTC instants collapse and span
 * according to the local calendar day the user sees.
 */
function toValidDate(iso: string | null): Date | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatSessionDateRange(
  earliestSessionAt: string | null,
  latestSessionAt: string | null
): string | null {
  const earliest = toValidDate(earliestSessionAt);
  const latest = toValidDate(latestSessionAt);
  if (!(earliest && latest)) {
    return null;
  }

  if (isSameLocalDate(earliest, latest)) {
    return formatDate(latest);
  }

  const start =
    earliest.getFullYear() === latest.getFullYear()
      ? formatMonthDay(earliest)
      : formatDate(earliest);
  return `${start} – ${formatDate(latest)}`;
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatMonthDay(date: Date): string {
  return MONTH_DAY_FORMATTER.format(date);
}
