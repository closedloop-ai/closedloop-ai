/**
 * Turn a validated {@link ColumnRegistry} plus the caller's current view state
 * into everything `GridTableV2` needs to paint — the champion composition for
 * the Gridview column system (ISS-9313, PRD-716 phase 03).
 *
 * `lib/column-registry` promises that "a host declares columns in one place
 * instead of spreading the same facts across a column array, a
 * `gridTemplateColumns` string, a hidden-column list and a `renderCell`
 * switch". `toGridColumns()` alone does not keep that promise: it emits every
 * declared column, in declaration order, at no width. The four facts stay
 * spread out, which is why every host in `packages/app` still hand-builds its
 * own track string beside its own ordering beside its own hidden set. This
 * module is the one place those four are derived TOGETHER, from the one
 * declaration, so a column and its track cannot come apart.
 *
 * ## What it decides, and what it refuses to decide
 *
 * - **Visibility** is capability-checked: a column the registry declares
 *   `hideable: false` is never hidden, however the view state asks. A view
 *   state that expresses no opinion at all falls back to `defaultHidden`.
 * - **Order** goes through `orderColumns`, so an id the registry never had is
 *   DISCARDED rather than painted as a phantom track — the same rule ISS-9447
 *   fixed as D1 for the persisted half.
 * - **Width** starts at each column's declared default, clamped to the shared
 *   floor, and takes the caller's override through `applyColumnWidths`.
 * - **Movability and resizability** come out as id lists, so the header grows a
 *   drag or resize affordance only where the column permits one.
 *
 * It decides nothing about PERSISTENCE. The view state is a plain in-memory
 * shape a caller passes in; the versioned stored representation, its migration
 * engine and its codec are ISS-9447's, and this module deliberately has no
 * opinion about how a caller got these three fields or where they go next.
 *
 * It does own the SHAPE of the order going back, though — `toPersistedColumnOrder`
 * merges a header-emitted visible order onto the complete one, so a caller that
 * feeds this module's own output back into it cannot lose a hidden column's
 * remembered slot. What that caller then does with the merged array is still
 * its own business.
 *
 * ## Two declarations this module does not consume
 *
 * - **`pinnable`.** `GridTableV2` pins the fixed leading identity column and
 *   nothing else; there is no per-column pin for a data column to switch on.
 * - **`priority`.** ISS-9451 Option A keeps every selected column: below a
 *   measured 768px content box the host supplies cards, while the grid keeps
 *   the complete selected set behind horizontal scrolling at and above 768px.
 *   Priority therefore changes neither visibility nor order and remains unread.
 */

import {
  applyColumnWidths,
  mergeColumnOrder,
  orderColumns,
} from "@closedloop-ai/design-system/lib/column-order";
import {
  clampColumnWidthToBounds,
  type ColumnDefinition,
  type ColumnRegistry,
  resolveColumnCapabilities,
  resolveColumnDefaultWidth,
  toGridColumn,
} from "@closedloop-ai/design-system/lib/column-registry";
import type { GridTableV2Column } from "@closedloop-ai/design-system/lib/grid-table-v2-types";

/**
 * The caller's current, IN-MEMORY view state. Every field is optional and an
 * absent field means "no opinion", which is not the same as an empty one: an
 * absent `hiddenColumnIds` falls back to each column's `defaultHidden`, while
 * an empty array is a user who has explicitly shown everything.
 */
export type ColumnLayoutViewState = {
  /** Column ids in the user's chosen order. Ids the registry lacks are dropped. */
  columnOrder?: readonly string[];
  /** Column ids the user has hidden. A non-hideable column is never hidden. */
  hiddenColumnIds?: readonly string[];
  /** Per-column pixel overrides. Ids the registry lacks are dropped. */
  columnWidths?: Readonly<Record<string, number>>;
};

/**
 * Caller-owned CSS grid tracks that bracket the data columns — the favourites
 * slot and the leading identity column before them, an Add-field slot after.
 * The registry declares data columns only, so these stay the caller's.
 */
export type ColumnLayoutTracks = {
  leadingTracks?: readonly string[];
  trailingTracks?: readonly string[];
};

/** Everything a `GridTableV2` host needs, derived from one declaration set. */
export type ResolvedColumnLayout = {
  /** The visible columns, in render order, as `GridTableV2`'s render prop. */
  columns: GridTableV2Column[];
  /** The full track string, data tracks bracketed by the caller's own. */
  gridTemplateColumns: string;
  /** The visible column ids in render order — `GridTableV2.columnOrder`. */
  columnOrder: string[];
  /**
   * Turn an order the HEADER emitted back into one that is safe to persist.
   *
   * {@link columnOrder} is the VISIBLE order, so that is what
   * `onColumnOrderChange` hands back — and writing it straight into
   * `ColumnLayoutViewState.columnOrder` drops every hidden column's remembered
   * slot. Hide cost, drag status ahead of name, persist, unhide: cost comes
   * back at the END rather than in its own place.
   *
   * Every v2 host today re-derives this merge beside its own table. It lives
   * here so the round trip is not the one fact of the four still left to the
   * caller.
   */
  toPersistedColumnOrder: (visibleOrder: readonly string[]) => string[];
  /** Rendered pixel width per visible column — `GridTableV2.columnWidths`. */
  columnWidths: Record<string, number>;
  /** Visible ids the user may reorder. A subset of {@link columnOrder}. */
  movableColumnIds: string[];
  /** Visible ids the user may resize — `TableGridHeaderV2Resize.columnIds`. */
  resizableColumnIds: string[];
  /** What is ACTUALLY hidden, after `hideable` is enforced. */
  hiddenColumnIds: string[];
};

/**
 * Resolve one declaration set plus one view state into one rendered layout.
 *
 * Pure: nothing is mutated and the same inputs always give the same output, so
 * a host wraps it in its own `useMemo` rather than this module owning a hook
 * and a React dependency.
 */
export function resolveColumnLayout(
  registry: ColumnRegistry,
  viewState?: ColumnLayoutViewState,
  tracks?: ColumnLayoutTracks
): ResolvedColumnLayout {
  const hiddenColumnIds = resolveHiddenColumnIds(
    registry.definitions,
    viewState?.hiddenColumnIds
  );
  const hidden = new Set(hiddenColumnIds);
  const visible = orderColumns(
    registry.definitions.filter((definition) => !hidden.has(definition.id)),
    viewState?.columnOrder
  );
  const naturalWidths: Record<string, number> = {};
  for (const definition of visible) {
    naturalWidths[definition.id] = resolveColumnDefaultWidth(definition);
  }
  const columnWidths = applyColumnWidths(
    naturalWidths,
    viewState?.columnWidths
  );
  const movableColumnIds: string[] = [];
  const resizableColumnIds: string[] = [];
  for (const definition of visible) {
    // `applyColumnWidths` has only the shared floor to answer to, so a column
    // declaring its own bounds would otherwise paint a restored width outside
    // them. Both edges are pinned here, against the declaration.
    columnWidths[definition.id] = clampColumnWidthToBounds(
      definition,
      columnWidths[definition.id]
    );
    const capabilities = resolveColumnCapabilities(definition);
    if (capabilities.movable) {
      movableColumnIds.push(definition.id);
    }
    if (capabilities.resizable) {
      resizableColumnIds.push(definition.id);
    }
  }
  // The complete set arranged by the caller's persisted order, so a prior move
  // of a now-hidden column survives as the merge base — the same base every
  // host builds by hand today.
  const completeOrder = orderColumns(
    registry.definitions,
    viewState?.columnOrder
  ).map((definition) => definition.id);
  return {
    columns: visible.map(toGridColumn),
    gridTemplateColumns: [
      ...(tracks?.leadingTracks ?? []),
      ...visible.map((definition) => `${columnWidths[definition.id]}px`),
      ...(tracks?.trailingTracks ?? []),
    ].join(" "),
    columnOrder: visible.map((definition) => definition.id),
    toPersistedColumnOrder: (visibleOrder) =>
      mergeColumnOrder(completeOrder, visibleOrder),
    columnWidths,
    movableColumnIds,
    resizableColumnIds,
    hiddenColumnIds,
  };
}

/**
 * Which ids are hidden once `hideable` has its say.
 *
 * A column declaring `hideable: false` is dropped from the answer whatever the
 * view state holds, so a stale stored layout — or a caller passing the wrong
 * list — can never strand a column the host declared unhideable.
 */
function resolveHiddenColumnIds(
  definitions: readonly ColumnDefinition[],
  requested: readonly string[] | undefined
): string[] {
  const requestedIds = requested === undefined ? undefined : new Set(requested);
  const hidden: string[] = [];
  for (const definition of definitions) {
    if (!resolveColumnCapabilities(definition).hideable) {
      continue;
    }
    const isHidden =
      requestedIds === undefined
        ? definition.defaultHidden === true
        : requestedIds.has(definition.id);
    if (isHidden) {
      hidden.push(definition.id);
    }
  }
  return hidden;
}
