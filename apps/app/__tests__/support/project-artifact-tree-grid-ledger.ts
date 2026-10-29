import { GRID_TABLE_V2_CAPABILITY_KINDS } from "@repo/app/shared/lib/grid-table-v2-capability-kinds";
import type { HostCapabilityLedger } from "./surface-capability-parity";
import { SUPPLIED } from "./surface-capability-parity";

const NO_SELECT_ALL = {
  notSupported:
    "ISS-13007 removes the header checkbox from this list; row selection and Cmd/Ctrl+A remain through the row-selection props and `onSelectAllRows`.",
} as const;
const NO_GROUPS = {
  notSupported:
    "The Project Detail tree is one ordered hierarchy, not grouped bands, so it has no group model, collapse state, icon, count, or group drop target to pass.",
} as const;
const FIXED_LAYOUT = {
  notSupported:
    "The controller supplies one composed tree grid template and ordered column array; this mount holds no separate column order, width, resize, or fold state for the grid to mutate.",
} as const;
const NO_SORTING = {
  notSupported:
    "Project Detail manual hierarchy order is the row order on this tree; this mount exposes no independent header sort model or clear-sort action.",
} as const;
const NO_CARD_FALLBACK = {
  notSupported:
    "This mount is explicitly expanded and preserves tree lineage, so it does not switch the hierarchy into a card renderer.",
} as const;
const NO_EXTRA_ROWS = {
  notSupported:
    "The tree has an optional inline-create row after one artifact, but no group footer or table-wide row after the hierarchy.",
} as const;

/** PRD-723 follow-up coverage for the Project Detail tree rollout mount. */
export const PROJECT_ARTIFACT_TREE_GRID_LEDGER: HostCapabilityLedger = {
  capabilities: {
    alignValuesToColumn: {
      notSupported:
        "The tree's semantic cells own their layout and expose no resolved per-column value alignment map.",
    },
    allSelected: NO_SELECT_ALL,
    canDragRow: {
      notSupported:
        "Manual ordering is enabled for the whole hierarchy at once by the conditional row-drop seam; this mount has no second per-row drag authority to express.",
    },
    canDropOnGroup: NO_GROUPS,
    canDropOnRow: SUPPLIED,
    cardRender: NO_CARD_FALLBACK,
    collapseRowLabel: SUPPLIED,
    columnOrder: FIXED_LAYOUT,
    columnWidths: FIXED_LAYOUT,
    defaultExpandedRowIds: { inertUnder: "rowExpansion" },
    enableRowRangeDrag: {
      notSupported:
        "This tree preserves its existing click and checkbox selection model; it does not activate the optional pointer range-drag gesture.",
    },
    expandRowLabel: SUPPLIED,
    foldFitSettleMs: { inertWithout: "snapFoldToColumns" },
    getCardSelectionLabel: { inertWithout: "cardRender" },
    getChildren: SUPPLIED,
    groupCollapse: NO_GROUPS,
    groupIcon: NO_GROUPS,
    groups: NO_GROUPS,
    headerActions: {
      notSupported:
        "Project Detail owns filtering and column controls above the tree rather than in a lead-header action menu.",
    },
    isRowSelected: SUPPLIED,
    leadingColumnWidth: FIXED_LAYOUT,
    leadingSortKey: NO_SORTING,
    leadingSortOptions: NO_SORTING,
    leadingTooltip: {
      notSupported:
        "The Artifact header needs no additional help text, and this mount has no human-authored tooltip copy to pass.",
    },
    leadingUtilityHeader: {
      notSupported:
        "The Favorite track is intentionally visually blank; supplying a node would replace the accessible label fallback.",
    },
    leadingUtilityLabel: SUPPLIED,
    mode: SUPPLIED,
    movableColumnIds: FIXED_LAYOUT,
    navigableHeaderCells: {
      notSupported:
        "The tree keeps its existing native cell tab stops and does not opt into the alternate navigable-header model.",
    },
    onClearSort: NO_SORTING,
    onColumnOrderChange: FIXED_LAYOUT,
    onColumnWidthChange: FIXED_LAYOUT,
    onGroupDrop: NO_GROUPS,
    onLeadingColumnWidthChange: FIXED_LAYOUT,
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowDrop: SUPPLIED,
    onRowExpandedChange: {
      notSupported:
        "The controlled rowExpansion adapter writes expansion directly to the hierarchy view, so a second change callback would duplicate the same event.",
    },
    onRowKeyboardNavigate: SUPPLIED,
    onRowRangeDrag: SUPPLIED,
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: NO_SELECT_ALL,
    onSelectAllRows: SUPPLIED,
    onSort: NO_SORTING,
    pinLeadColumn: {
      notSupported:
        "The tree uses its existing horizontal overflow wrapper and does not define a pinned Artifact column treatment.",
    },
    preferredActiveCellKey: {
      notSupported:
        "Project Detail records no previously focused tree row to restore as the preferred active cell.",
    },
    renderAfterGroup: NO_EXTRA_ROWS,
    renderAfterItem: SUPPLIED,
    renderAfterRows: NO_EXTRA_ROWS,
    renderLeadingUtility: SUPPLIED,
    renderLeadingUtilityInWide: SUPPLIED,
    renderNarrowTrailingAction: {
      notSupported:
        "This mount is explicitly expanded and has no narrow trailing row-action projection.",
    },
    resizableColumnIds: FIXED_LAYOUT,
    rowDragHandleOnly: {
      notSupported:
        "PRD-723 finding 723-F2 requires the visible handle, eligible title whitespace, and title link to remain equivalent row-drag origins.",
    },
    rowDragPreviewLabel: SUPPLIED,
    rowExpansion: SUPPLIED,
    showGroupCounts: { inertWithout: "groups" },
    showSelectAll: NO_SELECT_ALL,
    snapFoldToColumns: FIXED_LAYOUT,
    someSelected: NO_SELECT_ALL,
    sortBy: NO_SORTING,
    sortDir: NO_SORTING,
    suppressCellTabStops: {
      notSupported:
        "The tree preserves the native tab stops of its checkbox, hierarchy handle, title link, and cell controls.",
    },
    trailingHeader: {
      notSupported:
        "The Project Detail tree declares no trailing header track or add-field action.",
    },
    virtualizeRows: { inertUnder: "getChildren" },
    staticTableSemantics: {
      notSupported:
        "This surface is an interactive treegrid with a roving keyboard contract; static table roles would change how its rows and cells are navigated.",
    },
    preserveMeasuredContainer: {
      notSupported:
        "The surface does not control GridTableV2's responsive measured-frame transition: ProductGridTableV2 supplies the opt-in internally for auto mode, and this mount is explicitly expanded.",
    },
  },
  componentModule: "@repo/app/shared/components/product-grid-table-v2",
  componentName: "ProductGridTableV2",
  componentPath: "packages/app/shared/components/product-grid-table-v2.tsx",
  hostPath: "packages/app/projects/components/project-artifact-tree-grid.tsx",
  kinds: GRID_TABLE_V2_CAPABILITY_KINDS,
};
