import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { Priority } from "@repo/api/src/types/common";
import { DOCUMENT_LIST_DEFAULT_RECENCY_DAYS } from "@repo/api/src/types/document";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import type { TableFilters } from "@repo/app/documents/hooks/use-table-filters";
import { isArtifactStatus } from "@repo/app/documents/lib/artifact-status-facet-value";
import { tableFilterDateWindow } from "@repo/app/documents/lib/table-filter-date-window";
import type { AssignedTreeFacets } from "@repo/app/projects/hooks/use-assigned-artifact-tree";

/** Milliseconds in a day, for resolving the recency window to an instant. */
const MS_PER_DAY = 86_400_000;

/**
 * ISS-10472 — the My Tasks filter state as assigned-tree query facets.
 *
 * The All tab pages server-side, so its filters have to be applied by the
 * SERVER: a browser predicate over one page narrows the rows on screen rather
 * than the assignee's work, which is the same defect as searching one page.
 *
 * TWO SELECTIONS THIS CANNOT CARRY, both ruled on 2026-10-21 rather than
 * resolved here:
 *
 * - The `Unknown` status, a render bucket for an off-vocabulary row and not a
 *   stored value. The route's enum is the stored inventory, so the All tab does
 *   not OFFER the option — `supportsUnknownStatusFacet: false` on
 *   `useTableFilters`, which also drops it from the applied set. The filter
 *   below is what keeps it off the wire even so.
 * - The recency window's archived-project half, which has no route parameter at
 *   all. An active window narrows by age here and not by archival.
 *
 * `now` is a parameter, not a `Date.now()` call, for two reasons that are both
 * load-bearing. A window resolved per render puts a moving value in the
 * TanStack query key, which refetches forever; and a window that moves between
 * page requests returns page 2 from a different population than page 1 — the
 * skipped-or-duplicated row PRD-743 exists to remove, and the reason
 * `ArtifactDateWindow` carries resolved instants rather than a preset.
 */
export function assignedTreeFacetParams(
  filters: TableFilters,
  isRecencyWindowActive: boolean,
  now: Date
): AssignedTreeFacets {
  const facets: AssignedTreeFacets = {};

  // Narrowed, not cast: `TableFilters.statuses` is typed to include the
  // render-only `Unknown`, and this is the boundary past which only a STORED
  // status may travel.
  const statuses = filters.statuses.filter(isArtifactStatus);
  if (statuses.length > 0) {
    facets.status = statuses;
  }

  if (filters.priorities.length > 0) {
    // Every member sends, the unset token included: "no priority" is a value
    // this facet selects rather than a gap it cannot express (ISS-9665), and
    // the route's enum leads with that token.
    facets.priority = filters.priorities;
  }

  if (filters.tagIds.length > 0) {
    facets.tagId = filters.tagIds;
  }

  // Both booleans narrow only when true, which is what the route documents for
  // them — `false` narrows nothing, exactly as omission does.
  if (filters.favoritesOnly) {
    facets.favoritesOnly = true;
  }
  if (filters.hideCompletedItems) {
    facets.hideCompletedItems = true;
  }

  const dateWindow =
    tableFilterDateWindow(filters, now) ??
    resolveRecencyDateWindow(isRecencyWindowActive, now);
  if (dateWindow) {
    facets.dateField = dateWindow.field;
    facets.dateFrom = dateWindow.from;
    facets.dateTo = dateWindow.to;
  }

  return facets;
}

/**
 * The FEA-1626 recency window as a date facet (operator ruling 2026-10-21).
 *
 * Only the age half. The window's other half excludes archived projects and the
 * route has no parameter for it at all — tracked as ISS-12866, and reported to
 * humans there rather than on the screen.
 *
 * Reads `UpdatedAt` because that is the field the window's own copy names
 * ("Nothing updated in the last N days"), so the request and the empty state
 * describe the same narrowing.
 */
function resolveRecencyDateWindow(
  isRecencyWindowActive: boolean,
  now: Date
): { field: ArtifactDateField; from: Date; to: Date } | null {
  if (!isRecencyWindowActive) {
    return null;
  }
  return {
    field: ArtifactDateField.UpdatedAt,
    from: new Date(
      now.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * MS_PER_DAY
    ),
    to: now,
  };
}

/**
 * The flag-OFF reading of a `Medium` selection (ISS-9665, whitlockk on PR #9091).
 *
 * With `artifact-priority-unset` off, `withPriorityDisplayFallback` renders an
 * artifact holding NO priority as `Medium`, and the browser predicate the flat
 * tabs run matches it on that substituted value — so selecting Medium there
 * returns the unset rows too. The route filters the STORED column, so sending
 * `MEDIUM` alone drops them, and the same selection would mean different sets
 * on two tabs of one board.
 *
 * The unset token is added, never substituted: an artifact genuinely holding
 * `Medium` stays selected. Applied to the resolved facets rather than taken as
 * a flag argument, because the caller branches at its own read of the key
 * (`no-threaded-feature-flag`).
 */
export function withUnsetPriorityDisplayFallback(
  facets: AssignedTreeFacets
): AssignedTreeFacets {
  const priority = facets.priority;
  if (
    !priority?.includes(Priority.Medium) ||
    priority.includes(PRIORITY_UNSET_VALUE)
  ) {
    return facets;
  }
  return { ...facets, priority: [...priority, PRIORITY_UNSET_VALUE] };
}
