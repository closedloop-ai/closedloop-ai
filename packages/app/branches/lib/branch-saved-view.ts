import {
  PERSISTED_COLLAPSED_GROUPS_SCHEMA,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
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
  PERSISTED_VIEW_STATE_VERSIONS_SCHEMA,
  type ViewStateVersions,
} from "../../shared/lib/view-state-axes";
import type { BranchSortDir, BranchSortKey } from "./branch-sort-group";
import {
  BRANCH_STORED_SORT_DIR_SCHEMA,
  BRANCH_STORED_SORT_KEY_SCHEMA,
} from "./branch-sort-schema";

/**
 * Persisted Branches view (Epic B / B5b): the toolbar dimensions (sort, hidden
 * columns) saved to renderer `localStorage` keyed by surface and restored on
 * mount. Filter persistence is deferred (filters are session-ephemeral in v1);
 * on the eventual authed/web path this won't sync server-side — acceptable for
 * the local-first desktop surface.
 *
 * `parseBranchSavedView` is pure (and unit-tested); `useBranchViewState` wraps it
 * via the shared `usePersistedTableViewState`, whose `localStorage` load/save is
 * fail-soft (private mode, malformed JSON, unknown enum values all degrade to
 * `null`/no-op rather than throwing).
 *
 * ## ISS-9447 M5: unknown keys are KEPT, and the parse no longer nulls out
 *
 * The schema is `.loose()`, matching the named-view collection in
 * `branch-saved-views.ts`. The two stores in this domain used to hold opposite
 * postures, and inverted in the dangerous direction: this one persists MORE
 * (`columnWidths`, `pageSize`) and was the one that stripped, so a key a NEWER
 * build wrote — the `viewStateVersions` envelope included — was deleted by one
 * read→write cycle through this build. Preserving is only half of it: the keys
 * have to reach the surface's `extras` blob too, because `serializeTableView`
 * writes a fixed reserved set plus `extras` and nothing else. `parseSavedView`
 * in `use-branch-view-state.ts` owns that half.
 *
 * The sort pair no longer fails the whole parse either. A stored `sortKey` this
 * build cannot spell used to null the ENTIRE view, so a reader lost their
 * columns, window and grouping over one bad enum value. It now resolves through
 * the rename alias and then falls back to the default sort, which is the same
 * degrade-don't-discard trade every other axis here already takes.
 */
export type BranchSavedView = {
  sortKey: BranchSortKey;
  sortDir: BranchSortDir;
  dateRange: DateRange;
  hiddenColumns: string[];
  /** FEA-4021: persisted data-column order (ids). Empty ⇒ natural order. */
  columnOrder: string[];
  /** FEA-4168: persisted per-column widths (px), keyed by id. Empty ⇒ natural. */
  columnWidths: Record<string, number>;
  /** ISS-9676: the live grouping axis. A view stored before it existed restores ungrouped. */
  grouping: TableGroupingState;
  /**
   * ISS-9582: the bands collapsed under each grouping axis. A view stored before
   * it existed restores with every band open.
   */
  collapsedGroups: TableCollapsedGroups;
  /**
   * ISS-9692: persisted rows-per-page. `undefined` ⇒ nothing was stored (a view
   * written before this field existed), so the surface default stands. Kept RAW
   * rather than clamped to the ladder, which moves with a feature flag — the
   * render site resolves it (`useTablePageSizeOptions`).
   */
  pageSize?: number;
  /**
   * ISS-9447 M5: the per-axis migration stamps a stored view carries.
   *
   * Branches ships no view-state migration, so this build stamps nothing and
   * reads nothing out of it — it is CARRY-ONLY, and its whole job is that a
   * stamp a newer build wrote survives a round trip through this one. Validated
   * rather than merely passed through, so a corrupt or implausible stamp is
   * dropped here instead of being handed to the build that does have a
   * migration to skip.
   */
  viewStateVersions: ViewStateVersions;
  /** ISS-12664: summary-card ids the reader hid. A view stored before it existed restores with every card shown. */
  hiddenSummaryCards: string[];
} & Record<string, unknown>;

const branchSavedViewSchema = z
  .object({
    // ISS-9447 M5: the rename alias runs BEFORE the closed enum, then the enum
    // falls back rather than failing. Required-and-closed is what made one bad
    // sort value discard the reader's whole view. Shared with the named-view
    // collection so the two stores cannot answer it differently.
    sortKey: BRANCH_STORED_SORT_KEY_SCHEMA,
    sortDir: BRANCH_STORED_SORT_DIR_SCHEMA,
    dateRange: z.enum(DATE_RANGES).default(DEFAULT_DATE_RANGE),
    // Keep only the string entries of a (possibly mixed) array; a missing or
    // non-array value degrades to []. The element filter is a data-cleaning
    // preprocess, not object-shape validation (which is the schema's job).
    hiddenColumns: PERSISTED_STRING_ARRAY_SCHEMA,
    // FEA-4021: same data-cleaning preprocess as `hiddenColumns` — keep only the
    // string entries; a missing/non-array value degrades to the natural order.
    columnOrder: PERSISTED_STRING_ARRAY_SCHEMA,
    // FEA-4168: per-column widths (px), keyed by column id. Data-cleaning
    // preprocess keeps only entries whose value `isUsableColumnWidth` accepts;
    // a missing/non-object value degrades to {} (the table's natural widths).
    columnWidths: PERSISTED_COLUMN_WIDTHS_SCHEMA,
    // ISS-9676: additive and version-skewed both ways — a view written by a build
    // that had no grouping omits the key and restores ungrouped, and a partially
    // malformed level degrades to the same rather than failing the whole parse
    // and discarding the reader's columns with it.
    grouping:
      TABLE_GROUPING_SCHEMA.catch(EMPTY_TABLE_GROUPING).default(
        EMPTY_TABLE_GROUPING
      ),
    // ISS-9582: additive like `grouping` — absent or malformed degrades to
    // nothing collapsed rather than failing the parse.
    collapsedGroups: PERSISTED_COLLAPSED_GROUPS_SCHEMA,
    // ISS-9692: a malformed or non-positive value degrades to `undefined` rather
    // than failing the whole parse — losing the reader's sort and columns over a
    // corrupt page size would be a far worse trade than falling back to 25.
    pageSize: PERSISTED_PAGE_SIZE_SCHEMA,
    viewStateVersions: PERSISTED_VIEW_STATE_VERSIONS_SCHEMA,
    hiddenSummaryCards: PERSISTED_STRING_ARRAY_SCHEMA,
  })
  // ISS-9447 M5: see the type docstring. `.loose()` keeps a key only a NEWER
  // build names; `use-branch-view-state.ts` is what puts it back on the way out.
  .loose();

/** Validate untrusted parsed JSON into a `BranchSavedView`, else `null`. */
export function parseBranchSavedView(input: unknown): BranchSavedView | null {
  const result = branchSavedViewSchema.safeParse(input);
  return result.success ? result.data : null;
}
