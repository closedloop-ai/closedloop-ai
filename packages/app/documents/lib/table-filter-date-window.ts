import type { ArtifactDateWindow } from "@repo/api/src/types/artifact-date-filter";
import {
  DatePreset,
  dateRangeForPreset,
  type TableFilters,
} from "@repo/app/documents/hooks/use-table-filters";

/**
 * The table's Date filter as absolute bounds for a server-filtered read, or
 * null when none is set. Shared by My Tasks (ISS-10472) and the project board
 * (ISS-12929), so both send the window the browser predicate would apply.
 *
 * A custom range with a missing end is treated as unset rather than resolved to
 * `now`: a half-entered range is the user still typing, and inventing its other
 * end would filter against a window they never chose. An inverted range is
 * unset too, matching the browser's `isCustomRangeValid`.
 *
 * `now` is injected so a caller resolves the preset once per selection: a
 * window that moved between page requests would page a different population.
 */
export function tableFilterDateWindow(
  filters: TableFilters,
  now: Date
): ArtifactDateWindow | null {
  const date = filters.date;
  if (date === null) {
    return null;
  }
  if (date.preset === DatePreset.Custom) {
    if (!(date.startDate && date.endDate) || date.endDate < date.startDate) {
      return null;
    }
    return { field: date.field, from: date.startDate, to: date.endDate };
  }
  const range = dateRangeForPreset(date.preset, now);
  return range === null
    ? null
    : { field: date.field, from: range.start, to: range.end };
}
