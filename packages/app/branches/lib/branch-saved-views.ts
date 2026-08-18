import {
  emptySavedViewCollection,
  type SavedViewCollection,
} from "@repo/design-system/lib/table-saved-views";
import { z } from "zod";
import { DATE_RANGES, type DateRange } from "../../shared/lib/format-utils";
import type { BranchFilters } from "./branch-row";
import { DEFAULT_BRANCH_FILTERS } from "./branch-row";
import {
  type BranchSortDir,
  type BranchSortKey,
  BranchSortDir as SortDir,
  BranchSortKey as SortKey,
} from "./branch-sort-group";

/**
 * The full arrangement a NAMED Branches saved view captures (FEA-4180): the
 * sort dimensions, the time window, the visible-column set, and the persisted
 * column order — PLUS the active facet filters, which the single live saved
 * view (`branch-saved-view.ts`, FEA-4021) deliberately does not persist. A named
 * view is an explicit user-created snapshot, so filters belong in it.
 *
 * Column WIDTHS are intentionally absent: `columnWidths` lands in FEA-4168
 * (PR #3774, not yet merged to `main`). The arrangement is a plain object, so
 * once that merges `columnWidths?: Record<string, number>` slots in here as an
 * additive optional field (and into the schema below) with no migration — an
 * older persisted view simply omits it and the table falls back to natural
 * widths.
 */
export type BranchViewArrangement = {
  sortKey: BranchSortKey;
  sortDir: BranchSortDir;
  dateRange: DateRange;
  hiddenColumns: string[];
  columnOrder: string[];
  filters: BranchFilters;
};

const SORT_KEYS = Object.values(SortKey) as [BranchSortKey, ...BranchSortKey[]];
const SORT_DIRS = Object.values(SortDir) as [BranchSortDir, ...BranchSortDir[]];

// Keep only the string entries of a (possibly mixed) array; a missing/non-array
// value degrades to []. Mirrors the data-cleaning preprocess in
// `branch-saved-view.ts` so the two view stores parse column lists identically.
const stringArraySchema = z
  .preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [],
    z.array(z.string())
  )
  .default([]);

const numberOrUndefined = z
  .preprocess(
    (value) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined,
    z.number().optional()
  )
  .optional();

const branchFiltersSchema: z.ZodType<BranchFilters> = z
  .object({
    names: stringArraySchema,
    statuses: stringArraySchema,
    owners: stringArraySchema,
    collaborators: stringArraySchema,
    repos: stringArraySchema,
    pullRequests: stringArraySchema,
    lastActiveRanges: stringArraySchema,
    tags: stringArraySchema,
    sessionPresence: stringArraySchema,
    locMin: numberOrUndefined,
    locMax: numberOrUndefined,
  })
  // A missing/malformed `filters` blob degrades to "no facet active".
  .catch({ ...DEFAULT_BRANCH_FILTERS });

// `.loose()` (passthrough) so unknown arrangement keys a NEWER build persists —
// e.g. FEA-4168's `columnWidths` — survive this version's read→write cycle
// instead of being stripped and overwritten. That keeps the additive,
// no-migration contract: this build validates the fields it knows and leaves
// data it does not understand untouched, so a round-trip through an older
// client never silently drops a forward-compatible field.
const branchViewArrangementSchema = z
  .object({
    sortKey: z.enum(SORT_KEYS).default(SortKey.LastActivity),
    sortDir: z.enum(SORT_DIRS).default(SortDir.Desc),
    // Build the enum from the canonical DATE_RANGES const, not a copy of today's
    // members — a range added to DATE_RANGES then parses/persists correctly here
    // instead of silently degrading to the "7d" default.
    dateRange: z.enum(DATE_RANGES).default("7d"),
    hiddenColumns: stringArraySchema,
    columnOrder: stringArraySchema,
    filters: branchFiltersSchema,
  })
  .loose();

// Also `.loose()` at the view and collection levels for the same reason: a
// future build may add a top-level view field (a `description`) or a
// collection-level field, and this version must round-trip it untouched rather
// than strip it on the next write.
const savedViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arrangement: branchViewArrangementSchema,
  })
  .loose();

const collectionSchema = z
  .object({
    // Drop any view that fails validation rather than rejecting the whole
    // collection — one corrupt saved view must not blank the switcher.
    views: z
      .preprocess(
        (value) => (Array.isArray(value) ? value : []),
        z.array(z.unknown())
      )
      .transform((raw) =>
        raw.flatMap((item) => {
          const result = savedViewSchema.safeParse(item);
          return result.success ? [result.data] : [];
        })
      )
      .default([]),
    activeViewId: z.string().nullable().default(null),
  })
  .loose();

/**
 * Validate untrusted parsed JSON into a Branches `SavedViewCollection`, always
 * returning a usable collection (never `null`): a missing/malformed blob, or an
 * `activeViewId` naming a view that survived validation and dropping, degrades
 * to an empty collection / the default arrangement. Fail-soft so a bad persisted
 * value can never blank the switcher or throw.
 */
export function parseBranchSavedViews(
  input: unknown
): SavedViewCollection<BranchViewArrangement> {
  const result = collectionSchema.safeParse(input);
  if (!result.success) {
    return emptySavedViewCollection<BranchViewArrangement>();
  }
  const { views, activeViewId } = result.data;
  // Guard against a dangling active id (its view failed validation and was
  // dropped) so the switcher never points at a missing view.
  const activeExists =
    activeViewId !== null && views.some((view) => view.id === activeViewId);
  // Spread `result.data` first so any unknown collection-level keys a NEWER
  // build persisted survive this round-trip (see the `.loose()` note above),
  // then override the validated/clamped `activeViewId` last so it always wins.
  return {
    ...result.data,
    views,
    activeViewId: activeExists ? activeViewId : null,
  };
}

/**
 * The canonical DEFAULT Branches arrangement (FEA-4180): the sort, window,
 * column visibility/order and facet filters a fresh surface (and the switcher's
 * "Default view" entry) restores to. Selecting "Default view" — or deleting the
 * active view — must APPLY this, not merely clear the active marker, so the
 * table actually returns to the state the trigger claims. Kept as one exported
 * constant so the hook, the reset-view control, and the tests all agree on what
 * "default" means. Filters come from `DEFAULT_BRANCH_FILTERS` (empty facets);
 * empty `hiddenColumns`/`columnOrder` mean "all columns visible, natural order",
 * matching `useBranchViewState`'s `resetColumns` and the table's natural order.
 */
export const DEFAULT_BRANCH_ARRANGEMENT: BranchViewArrangement = {
  sortKey: SortKey.LastActivity,
  sortDir: SortDir.Desc,
  dateRange: "7d",
  hiddenColumns: [],
  columnOrder: [],
  filters: { ...DEFAULT_BRANCH_FILTERS },
};

// Order-insensitive string-list equality — `hiddenColumns` and the facet
// arrays describe SETS (a user hiding A then B produces the same view as B
// then A), so comparing them positionally would false-flag a view as modified.
function stringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function branchFiltersEqual(a: BranchFilters, b: BranchFilters): boolean {
  return (
    stringListsEqual(a.names, b.names) &&
    stringListsEqual(a.statuses, b.statuses) &&
    stringListsEqual(a.owners, b.owners) &&
    stringListsEqual(a.collaborators, b.collaborators) &&
    stringListsEqual(a.repos, b.repos) &&
    stringListsEqual(a.pullRequests, b.pullRequests) &&
    stringListsEqual(a.lastActiveRanges, b.lastActiveRanges) &&
    stringListsEqual(a.tags, b.tags) &&
    stringListsEqual(a.sessionPresence, b.sessionPresence) &&
    a.locMin === b.locMin &&
    a.locMax === b.locMax
  );
}

/**
 * Whether two Branches arrangements are EQUIVALENT (FEA-4180). Used to tell
 * whether the live table has diverged from the saved active view so the
 * switcher can show a "modified" marker and offer "Update <name>" instead of
 * letting the trigger claim a state the table is no longer in. `columnOrder` is
 * compared positionally (order is meaningful); `hiddenColumns` and the facet
 * arrays are compared as sets (order is not).
 */
export function branchArrangementsEqual(
  a: BranchViewArrangement,
  b: BranchViewArrangement
): boolean {
  return (
    a.sortKey === b.sortKey &&
    a.sortDir === b.sortDir &&
    a.dateRange === b.dateRange &&
    stringListsEqual(a.hiddenColumns, b.hiddenColumns) &&
    a.columnOrder.length === b.columnOrder.length &&
    a.columnOrder.every((value, index) => value === b.columnOrder[index]) &&
    branchFiltersEqual(a.filters, b.filters)
  );
}
