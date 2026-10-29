import {
  collapsedGroupsEqual,
  PERSISTED_COLLAPSED_GROUPS_SCHEMA,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  tableGroupingsEqual,
} from "@repo/design-system/components/ui/table-toolbar-model";
import {
  emptySavedViewCollection,
  type SavedViewCollection,
} from "@repo/design-system/lib/table-saved-views";
import { z } from "zod";
import {
  DATE_RANGES,
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "../../shared/lib/format-utils";
import { TABLE_GROUPING_SCHEMA } from "../../shared/lib/table-grouping-serialization";
import {
  PERSISTED_COLUMN_WIDTHS_SCHEMA,
  PERSISTED_PAGE_SIZE_SCHEMA,
  PERSISTED_STRING_ARRAY_SCHEMA,
} from "../../shared/lib/view-state-axes";
import {
  normalizeBranchColumnIds,
  normalizeBranchColumnWidths,
} from "./branch-column-renames";
import type { BranchFilters } from "./branch-row";
import { DEFAULT_BRANCH_FILTERS } from "./branch-row";
import {
  type BranchSortDir,
  type BranchSortKey,
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "./branch-sort-group";
import {
  BRANCH_STORED_SORT_DIR_SCHEMA,
  BRANCH_STORED_SORT_KEY_SCHEMA,
} from "./branch-sort-schema";

/**
 * The full arrangement a NAMED Branches saved view captures (FEA-4180): the
 * sort dimensions, the time window, the visible-column set, the persisted
 * column order, the column widths and the rows-per-page — PLUS the active facet
 * filters, which the single live saved view (`branch-saved-view.ts`, FEA-4021)
 * deliberately does not persist. A named view is an explicit user-created
 * snapshot, so filters belong in it.
 *
 * `columnWidths` and `pageSize` were the two dimensions the live view persisted
 * and this one did not, which is the drift ISS-9447 M5 closes. Both slot in as
 * the module docstring always said they would: additive, no migration, an older
 * persisted view simply omits them and resolves to natural widths and the
 * surface's default page size.
 */
export type BranchViewArrangement = {
  sortKey: BranchSortKey;
  sortDir: BranchSortDir;
  dateRange: DateRange;
  hiddenColumns: string[];
  columnOrder: string[];
  /** FEA-4168 / ISS-9447 M5: per-column widths (px), keyed by id. {} ⇒ natural. */
  columnWidths: Record<string, number>;
  filters: BranchFilters;
  /**
   * ISS-9676: the grouping axis, which is a view dimension like the sort and
   * the column set. Without it a reader groups the list, saves the view, and
   * gets it back ungrouped — a switcher naming a view the table is not on.
   */
  grouping: TableGroupingState;
  /**
   * ISS-9582: the bands collapsed under each grouping axis. Without it a reader
   * collapses bands, saves the view, and gets every band back open.
   */
  collapsedGroups: TableCollapsedGroups;
  /**
   * ISS-9692 / ISS-9447 M5: rows-per-page. Optional because a view saved before
   * this field existed carries none, and "none" is not a choice the reader made.
   *
   * The two readers answer that absence DIFFERENTLY, and deliberately. The
   * modified-marker comparison resolves it through
   * {@link branchArrangementPageSize} — an old view and a table sitting at the
   * surface default are not "modified". The APPLY reads it raw and does nothing
   * when it is absent, because a view that captured no rows-per-page is not
   * asking for the reader's current one to be replaced. `DEFAULT_BRANCH_ARRANGEMENT`
   * is the one arrangement that spells the field, since "the defaults" does
   * state an opinion about it.
   */
  pageSize?: number;
};

/**
 * The half of an arrangement that lands on the LIVE table state — everything
 * but the facet filters, which live in `useBranchFilterState` and are applied
 * on their own path.
 *
 * Derived from {@link BranchViewArrangement} rather than spelled out, because
 * it was spelled out three times (the view-state hook, the saved-views apply
 * bundle, and the desktop adapter's wrapper) and adding a dimension meant
 * finding all three. Now adding one to the arrangement adds it here.
 */
export type BranchAppliedArrangement = Omit<BranchViewArrangement, "filters">;

// Keep only the string entries of a (possibly mixed) array; a missing/non-array
// value degrades to []. ISS-9447 M2: the SAME schema `branch-saved-view.ts`
// parses with, so the two view stores in this domain cannot drift on it — they
// had drifted on `columnWidths` and `pageSize`, which M5 has since added to the
// arrangement below.
const stringArraySchema = PERSISTED_STRING_ARRAY_SCHEMA;

// The same cleaning, then the rename alias — a persisted column-id list is a
// list of column ids on both stores, so both resolve renames on the same read
// boundary rather than one of them discovering the seam is missing.
const columnIdListSchema = stringArraySchema.transform(
  normalizeBranchColumnIds
);

// The same cleaning, then the same alias applied to the map's KEYS. Widths are
// keyed by column id too, so leaving them off the rename boundary is how a
// rename half-applies: sort, visibility and order move to the new id while the
// width stays under the old one and is dropped as a column this build cannot
// draw (`filterValidColumnWidths`).
const columnWidthMapSchema = PERSISTED_COLUMN_WIDTHS_SCHEMA.transform(
  normalizeBranchColumnWidths
);

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
    // ISS-10332. `stringArraySchema` defaults an ABSENT key, so a named view
    // saved before this facet existed reads as "no priority filter".
    priorities: stringArraySchema,
    sessionPresence: stringArraySchema,
    locMin: numberOrUndefined,
    locMax: numberOrUndefined,
    // PRD-721. Optional so a view saved before the term existed still reads.
    search: z.string().optional(),
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
    // ISS-9447 M5: the rename alias in front of the closed enum, and a fallback
    // behind it. A `.default()` alone only answers an ABSENT key — a stored
    // value this build cannot spell still failed the arrangement, and a failed
    // arrangement drops the whole named view out of the switcher.
    sortKey: BRANCH_STORED_SORT_KEY_SCHEMA,
    sortDir: BRANCH_STORED_SORT_DIR_SCHEMA,
    // Build the enum from the canonical DATE_RANGES const, not a copy of today's
    // members — a range added to DATE_RANGES then parses/persists correctly here
    // instead of silently degrading to the default.
    dateRange: z.enum(DATE_RANGES).default(DEFAULT_DATE_RANGE),
    hiddenColumns: columnIdListSchema,
    columnOrder: columnIdListSchema,
    // ISS-9447 M5: the same widths schema the live view parses with, rename
    // alias included. Additive — a view saved before this omits the key and
    // resolves to natural widths.
    columnWidths: columnWidthMapSchema,
    filters: branchFiltersSchema,
    // Additive, with the same version-skew fallback the other axes take: a view
    // saved before ISS-9676 has no `grouping` key and restores ungrouped rather
    // than failing validation and being dropped from the collection.
    grouping:
      TABLE_GROUPING_SCHEMA.catch(EMPTY_TABLE_GROUPING).default(
        EMPTY_TABLE_GROUPING
      ),
    // ISS-9582: a view saved before the field restores with every band open.
    collapsedGroups: PERSISTED_COLLAPSED_GROUPS_SCHEMA,
    // ISS-9447 M5: stays `undefined` when absent or malformed, which
    // `branchArrangementPageSize` reads as "the surface default".
    pageSize: PERSISTED_PAGE_SIZE_SCHEMA,
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
  sortKey: DEFAULT_BRANCH_SORT_KEY,
  sortDir: DEFAULT_BRANCH_SORT_DIR,
  dateRange: DEFAULT_DATE_RANGE,
  hiddenColumns: [],
  columnOrder: [],
  // Natural widths, matching what `useBranchViewState`'s `resetColumns` lands
  // on: "Default view" has to APPLY the shipped arrangement, and a width the
  // reader dragged on a named view is part of what it replaces.
  columnWidths: {},
  filters: { ...DEFAULT_BRANCH_FILTERS },
  grouping: EMPTY_TABLE_GROUPING,
  collapsedGroups: {},
  // SPELLED, unlike every other arrangement's optional `pageSize`. Omitted means
  // "this view states nothing about rows-per-page", which the apply path honours
  // by leaving the live size alone — and "Default view" is precisely the case
  // that DOES state one: selecting it restores the shipped arrangement, and a
  // 100 the reader picked on the view they are leaving is part of what it
  // replaces. Reading it through `branchArrangementPageSize` still resolves the
  // same value, so the modified-marker comparison is unchanged.
  pageSize: DEFAULT_TABLE_PAGE_SIZE,
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
    stringListsEqual(a.priorities, b.priorities) &&
    stringListsEqual(a.sessionPresence, b.sessionPresence) &&
    a.locMin === b.locMin &&
    a.locMax === b.locMax &&
    (a.search ?? "") === (b.search ?? "")
  );
}

// Key-by-key width equality. Widths describe a MAP, so neither order nor the
// insertion history of the two objects can matter.
function columnWidthsEqual(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>
): boolean {
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) {
    return false;
  }
  return ids.every((id) => a[id] === b[id]);
}

/**
 * Whether two Branches arrangements are EQUIVALENT (FEA-4180). Used to tell
 * whether the live table has diverged from the saved active view so the
 * switcher can show a "modified" marker and offer "Update <name>" instead of
 * letting the trigger claim a state the table is no longer in. `columnOrder` is
 * compared positionally (order is meaningful); `hiddenColumns`, `columnWidths`
 * and the facet arrays are compared as sets/maps (order is not).
 *
 * EVERY field of {@link BranchViewArrangement} is compared, and adding one
 * without comparing it is the specific way this function goes wrong: the marker
 * is a claim that the table matches the saved view, so a field left out makes
 * that claim false for the axis it forgot. `branch-saved-views.test.ts` mutates
 * each field in turn from a table the compiler makes exhaustive, so a new field
 * fails typecheck there rather than shipping an unwatched axis.
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
    columnWidthsEqual(a.columnWidths, b.columnWidths) &&
    branchFiltersEqual(a.filters, b.filters) &&
    tableGroupingsEqual(a.grouping, b.grouping) &&
    collapsedGroupsEqual(a.collapsedGroups, b.collapsedGroups) &&
    branchArrangementPageSize(a) === branchArrangementPageSize(b)
  );
}

/**
 * The rows-per-page an arrangement RESOLVES to.
 *
 * `pageSize` is optional on the stored shape because a view saved before
 * ISS-9447 M5 carries none — and absent is not "the reader chose 25", it is
 * "nothing was stored", which resolves to the same 25 the surface ships. One
 * helper for both readers on purpose: resolve it in the apply but not in
 * {@link branchArrangementsEqual} and switching to an older view would report
 * itself modified the instant it was applied.
 */
export function branchArrangementPageSize(arrangement: {
  pageSize?: number;
}): number {
  return arrangement.pageSize ?? DEFAULT_TABLE_PAGE_SIZE;
}

/**
 * The arrangement to STORE when "Update <name>" folds the live table back into
 * an existing saved view: the live arrangement laid over what that view already
 * held.
 *
 * Without it the preserve guarantee this parser ships — `.loose()`, so a key
 * only a NEWER build names round-trips through this one untouched — held for
 * read→write of the COLLECTION and not for a normal edit.
 * `updateSavedView` replaces the arrangement wholesale (it says so, and that is
 * the right contract for a domain-free model), and the caller hands it a
 * freshly-normalized snapshot built from this build's owned axes alone, so every
 * unknown key was deleted the moment a reader clicked Update. The merge belongs
 * here rather than in `@repo/design-system`, which is gated from domain code and
 * owns only the collection shape.
 *
 * A wholesale spread of `live`, deliberately, rather than picking the axes by
 * name: an axis added to {@link BranchViewArrangement} then wins here by
 * construction. Picking would leave a new axis frozen at its stored value on
 * every Update, with nothing failing to say so.
 */
export function mergeBranchArrangement(
  stored: BranchViewArrangement,
  live: BranchViewArrangement
): BranchViewArrangement {
  return { ...stored, ...live };
}
