import { GRID_TABLE_V2_CAPABILITY_KINDS } from "@repo/app/shared/lib/grid-table-v2-capability-kinds";
import {
  type HostCapabilityLedger,
  SUPPLIED,
} from "./surface-capability-parity";

const NO_SELECTION =
  "The related-session detail table has no row selection or bulk-action model.";
const NO_LINEAGE =
  "The detail table renders flat Session rows without parent/child lineage or expansion.";
const NO_EXTRA_ROWS =
  "The detail table has no per-row expansion panel, after-band content or body footer.";

/** Production detail mount: static table roles, compact SessionCard, and native links. */
export const SESSION_DETAIL_GRID_LEDGER = {
  capabilities: {
    alignValuesToColumn: {
      notSupported:
        "Detail values use existing cell renderers and fixed tracks, not a per-column value-alignment model.",
    },
    allSelected: { inertWithout: "showSelectAll" },
    canDragRow: { inertWithout: "onGroupDrop" },
    canDropOnGroup: { inertWithout: "onGroupDrop" },
    canDropOnRow: { inertWithout: "onRowDrop" },
    cardRender: {
      notSupported:
        "The compact SessionCard reaches the grid through ProductGridTableV2's `cardCompatibility` adapter; a direct `cardRender` beside it would be a second card renderer for one table.",
    },
    getCardSelectionLabel: { inertWithout: "cardRender" },
    rowDragPreviewLabel: {
      notSupported:
        "The detail table has no native row drag of any kind, so there is no drag for a grip-and-title preview to follow.",
    },
    collapseRowLabel: { inertWithout: "getChildren" },
    columnOrder: SUPPLIED,
    columnWidths: {
      notSupported:
        "Fixed detail tracks have no resizable-width state to pass into the grid.",
    },
    defaultExpandedRowIds: { inertWithout: "getChildren" },
    enableRowRangeDrag: { inertWithout: "onRowRangeDrag" },
    expandRowLabel: { inertWithout: "getChildren" },
    foldFitSettleMs: SUPPLIED,
    getChildren: { notSupported: NO_LINEAGE },
    groupCollapse: {
      notSupported:
        "Detail band collapse is ephemeral grid state, not persisted or linked view state.",
    },
    groupIcon: SUPPLIED,
    groups: SUPPLIED,
    headerActions: {
      notSupported:
        "Column actions belong to the surrounding detail workspace, not this table header.",
    },
    isRowSelected: { inertWithout: "showSelectAll" },
    leadingColumnWidth: {
      notSupported:
        "The lead track is already built into the fixed detail grid template.",
    },
    leadingSortKey: {
      notSupported:
        "The detail table has no separate identity-sort key beyond configured data columns.",
    },
    leadingSortOptions: {
      notSupported:
        "The detail table exposes no alternate identity keys or lead-header sort menu.",
    },
    leadingTooltip: {
      notSupported:
        "The detail table has no lead-column help copy beyond its Session heading.",
    },
    leadingUtilityHeader: { inertWithout: "renderLeadingUtility" },
    leadingUtilityLabel: { inertWithout: "renderLeadingUtility" },
    mode: SUPPLIED,
    movableColumnIds: {
      notSupported:
        "Detail columns declare no per-column immovability; every ordered column may move.",
    },
    navigableHeaderCells: {
      notSupported:
        "Static table roles retain native header and link tab stops, not a roving-header walk.",
    },
    onClearSort: { inertWithout: "leadingSortOptions" },
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: {
      notSupported:
        "Fixed detail tracks have no width persistence or resize callback.",
    },
    onGroupDrop: {
      notSupported:
        "The related-session detail table cannot reassign a Session by band drop.",
    },
    onLeadingColumnWidthChange: {
      notSupported: "The fixed lead track has no width persistence callback.",
    },
    onRenderedItemsChange: {
      notSupported:
        "No external row-selection or virtualization state consumes rendered detail items.",
    },
    onRowClick: {
      notSupported:
        "Detail rows navigate through their name links, not a row-wide click target.",
    },
    onRowDrop: {
      notSupported:
        "The related-session detail table has no row-placement operation.",
    },
    onRowExpandedChange: { inertWithout: "getChildren" },
    onRowKeyboardNavigate: {
      notSupported:
        "Static table roles keep native link navigation instead of a row-level keyboard route.",
    },
    onRowRangeDrag: { notSupported: NO_SELECTION },
    onRowSelectionToggle: { notSupported: NO_SELECTION },
    onSelectAll: { inertWithout: "showSelectAll" },
    onSelectAllRows: { inertWithout: "showSelectAll" },
    onSort: SUPPLIED,
    pinLeadColumn: {
      notSupported:
        "The static detail table has no sticky identity-track contract.",
    },
    preferredActiveCellKey: {
      notSupported:
        "Static table roles do not use the grid's resumed active-cell key.",
    },
    preserveMeasuredContainer: {
      notSupported:
        "The detail table's always-active card compatibility already keeps its measured container mounted across modes.",
    },
    renderAfterGroup: { notSupported: NO_EXTRA_ROWS },
    renderAfterItem: { notSupported: NO_EXTRA_ROWS },
    renderAfterRows: { notSupported: NO_EXTRA_ROWS },
    renderLeadingUtility: {
      notSupported:
        "No favorite or other utility control precedes a detail Session name.",
    },
    renderLeadingUtilityInWide: { inertWithout: "renderLeadingUtility" },
    renderNarrowTrailingAction: {
      notSupported:
        "Detail rows have no narrow-only trailing action; navigation remains in the name link.",
    },
    resizableColumnIds: { inertWithout: "onColumnWidthChange" },
    rowDragHandleOnly: {
      notSupported:
        "The detail table has no row drag handle or row-drag gesture.",
    },
    rowExpansion: { inertWithout: "getChildren" },
    showGroupCounts: SUPPLIED,
    showSelectAll: { notSupported: NO_SELECTION },
    snapFoldToColumns: SUPPLIED,
    someSelected: { inertWithout: "showSelectAll" },
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    staticTableSemantics: SUPPLIED,
    suppressCellTabStops: {
      notSupported:
        "Static table roles retain native tab stops for detail-cell links.",
    },
    trailingHeader: {
      notSupported:
        "The detail table has no Add field or other trailing header control.",
    },
    virtualizeRows: { inertUnder: "groups" },
  },
  componentModule: "@repo/app/shared/components/product-grid-table-v2",
  componentName: "ProductGridTableV2",
  componentPath: "packages/app/shared/components/product-grid-table-v2.tsx",
  hostPath: "packages/app/agents/components/sessions/session-detail-table.tsx",
  kinds: GRID_TABLE_V2_CAPABILITY_KINDS,
} as const satisfies HostCapabilityLedger;
