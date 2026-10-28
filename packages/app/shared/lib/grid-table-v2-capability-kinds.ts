import type { GridTableV2Props } from "@repo/design-system/lib/grid-table-v2-types";
import {
  HOST_CAPABILITY,
  PRESENTATION,
  type SurfaceCapabilityKinds,
} from "./surface-capability-kind";

/**
 * ISS-9223 — for every optional prop of `GridTableV2`, whether a SURFACE may
 * honestly say it cannot pass one.
 *
 * The host↔surface guard (ISS-9218) classifies one seam only, and all three of
 * its kind maps are surface-prop maps. Nothing read `GridTableV2`'s prop set
 * across its callers, so a capability one list surface passed and another did
 * not stayed invisible — which is the class of defect ISS-9223 was itself an
 * instance of, one layer below the seam that already had a guard.
 *
 * DECLARED HERE, not beside the prop type, and that is forced rather than
 * chosen: `surface-capability-kind.ts` lives in `@repo/app`, and
 * `packages/design-system` is gated from importing it (`biome.jsonc`
 * `noRestrictedImports` plus `scripts/lint/check-design-system-domain-imports.ts`).
 * A kinds map inside the design system would also be Symphony domain code in a
 * deliberately project-agnostic package. This module is the nearest owner that
 * CAN carry the binding, and the `satisfies` below is the binding: a prop added
 * to `GridTableV2Props` and not classified here fails `tsc`, and an entry the
 * prop type no longer declares fails it too.
 *
 * WHY SO LITTLE IS {@link PRESENTATION} at this seam, when five props were at
 * the seam above. There the two consumers were two SHELLS of one surface, so a
 * seed either shell could produce was a genuine presentation default. Here the
 * consumers are three different tables — Sessions, Branches, Artifacts — and
 * nearly every optional prop carries that table's OWN content or contract: its
 * copy, its row data, its selection model, its persisted widths, its keyboard
 * model. A table that ships no selection is not withholding a default; it has
 * nothing to wire. What is left as presentation is the four props that are
 * inert without a companion this ledger already carries, so the class check
 * rests on a dependency the differ verifies rather than on prose.
 */
export const GRID_TABLE_V2_CAPABILITY_KINDS = {
  alignValuesToColumn: HOST_CAPABILITY,
  allSelected: HOST_CAPABILITY,
  canDragRow: HOST_CAPABILITY,
  canDropOnGroup: HOST_CAPABILITY,
  canDropOnRow: HOST_CAPABILITY,
  cardRender: HOST_CAPABILITY,
  // Restricting a drag to a handle changes this table's gesture contract.
  rowDragHandleOnly: HOST_CAPABILITY,
  rowDragPreviewLabel: HOST_CAPABILITY,
  collapseRowLabel: PRESENTATION,
  columnOrder: HOST_CAPABILITY,
  columnWidths: HOST_CAPABILITY,
  defaultExpandedRowIds: PRESENTATION,
  // This switches on a selection gesture owned by each product surface, rather
  // than tuning how an already-owned gesture is painted.
  enableRowRangeDrag: HOST_CAPABILITY,
  expandRowLabel: PRESENTATION,
  // ISS-4906 damps ISS-4889's fit in time; it configures nothing on its own and
  // the primitive ignores it outright without `snapFoldToColumns`, so a host
  // that withholds the fit declares this inert behind it rather than grading a
  // sentence about a number.
  foldFitSettleMs: PRESENTATION,
  getChildren: HOST_CAPABILITY,
  getCardSelectionLabel: HOST_CAPABILITY,
  groupCollapse: HOST_CAPABILITY,
  groupIcon: HOST_CAPABILITY,
  groups: HOST_CAPABILITY,
  headerActions: HOST_CAPABILITY,
  isRowSelected: HOST_CAPABILITY,
  leadingColumnWidth: HOST_CAPABILITY,
  leadingSortKey: HOST_CAPABILITY,
  leadingSortOptions: HOST_CAPABILITY,
  leadingTooltip: HOST_CAPABILITY,
  leadingUtilityHeader: HOST_CAPABILITY,
  leadingUtilityLabel: HOST_CAPABILITY,
  mode: HOST_CAPABILITY,
  movableColumnIds: HOST_CAPABILITY,
  navigableHeaderCells: HOST_CAPABILITY,
  onClearSort: HOST_CAPABILITY,
  onColumnOrderChange: HOST_CAPABILITY,
  onColumnWidthChange: HOST_CAPABILITY,
  onGroupDrop: HOST_CAPABILITY,
  onLeadingColumnWidthChange: HOST_CAPABILITY,
  onRenderedItemsChange: HOST_CAPABILITY,
  onRowClick: HOST_CAPABILITY,
  onRowExpandedChange: HOST_CAPABILITY,
  onRowKeyboardNavigate: HOST_CAPABILITY,
  onRowDrop: HOST_CAPABILITY,
  onRowRangeDrag: HOST_CAPABILITY,
  onRowSelectionToggle: HOST_CAPABILITY,
  onSelectAll: HOST_CAPABILITY,
  onSelectAllRows: HOST_CAPABILITY,
  onSort: HOST_CAPABILITY,
  pinLeadColumn: HOST_CAPABILITY,
  preferredActiveCellKey: HOST_CAPABILITY,
  preserveMeasuredContainer: HOST_CAPABILITY,
  renderAfterGroup: HOST_CAPABILITY,
  renderAfterItem: HOST_CAPABILITY,
  renderAfterRows: HOST_CAPABILITY,
  renderLeadingUtility: HOST_CAPABILITY,
  renderLeadingUtilityInWide: HOST_CAPABILITY,
  renderNarrowTrailingAction: HOST_CAPABILITY,
  resizableColumnIds: HOST_CAPABILITY,
  rowExpansion: HOST_CAPABILITY,
  showGroupCounts: HOST_CAPABILITY,
  showSelectAll: HOST_CAPABILITY,
  // Whether a table's fold should land on a column boundary is a fact about
  // THAT table's layout and the column set it declares — the one thing the
  // HOST_CAPABILITY doc names alongside data and persisted state — not a
  // rendering default the primitive would otherwise pick.
  snapFoldToColumns: HOST_CAPABILITY,
  sortBy: HOST_CAPABILITY,
  someSelected: HOST_CAPABILITY,
  sortDir: HOST_CAPABILITY,
  staticTableSemantics: HOST_CAPABILITY,
  suppressCellTabStops: HOST_CAPABILITY,
  trailingHeader: HOST_CAPABILITY,
  // ISS-12288. {@link PRESENTATION} rather than a capability, and it is the
  // clearest case of it in this map: the window carries none of a table's
  // content or contract — no copy, no data, no selection model, no persisted
  // state — and any host could pass `true`. What it configures is rendering the
  // primitive otherwise defaults, which is exactly why a table that omits it is
  // choosing that default silently and two tables choosing differently is a
  // divergence only the reader sees.
  virtualizeRows: PRESENTATION,
} as const satisfies SurfaceCapabilityKinds<GridTableV2Props<unknown>>;
