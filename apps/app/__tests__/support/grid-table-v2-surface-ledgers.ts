import { GRID_TABLE_V2_CAPABILITY_KINDS } from "@repo/app/shared/lib/grid-table-v2-capability-kinds";
import { SESSION_DETAIL_GRID_LEDGER } from "./grid-table-v2-session-detail-ledger";
import { PROJECT_ARTIFACT_TREE_GRID_LEDGER } from "./project-artifact-tree-grid-ledger";
import {
  type HostCapabilityLedger,
  SUPPLIED,
} from "./surface-capability-parity";

/**
 * ISS-9223 — the surface→`GridTableV2` audit, kept executable.
 *
 * One ledger per PRODUCTION module that mounts the primitive, classifying every
 * optional prop it declares. The seam above (ISS-8636/ISS-9218) audits
 * host→surface; nothing read the primitive's prop set across its callers, so a
 * capability one table passed and another did not was invisible.
 *
 * The reasons below describe what each TABLE is, not what a shell lacks, which
 * is the difference between this seam and the one above: these three consumers
 * are three different products sharing one grid.
 */

export const GRID_TABLE_V2_COMPONENT_PATH =
  "packages/design-system/components/ui/grid-table-v2.tsx";
export const GRID_TABLE_V2_COMPONENT_MODULE =
  "@repo/design-system/components/ui/grid-table-v2";
export const GRID_TABLE_V2_COMPONENT_NAME = "GridTableV2";
export const PRODUCT_GRID_TABLE_V2_COMPONENT_PATH =
  "packages/app/shared/components/product-grid-table-v2.tsx";
export const PRODUCT_GRID_TABLE_V2_COMPONENT_MODULE =
  "@repo/app/shared/components/product-grid-table-v2";
export const PRODUCT_GRID_TABLE_V2_COMPONENT_NAME = "ProductGridTableV2";

/**
 * ISS-9335 gave the project board's grouped body the first lineage mount, so
 * this is no longer "no consumer": it is the three FLAT tables, which render a
 * collection with no parent/child relation to descend.
 */
const NO_ROW_LINEAGE =
  "This table renders a flat collection and passes no `getChildren`, so it is a `grid` and not a `treegrid`: there is no lineage to expand and no expansion to be told about.";
const INERT_WITHOUT_LINEAGE = { inertWithout: "getChildren" } as const;
/** ISS-8747's drag reports through `onRowRangeDrag`, so it leads. */
const INERT_WITHOUT_RANGE_DRAG = { inertWithout: "onRowRangeDrag" } as const;
/**
 * ISS-4906's settle window is read only by ISS-4889's fit, so a table that does
 * not snap its fold has nothing for it to damp.
 */
const INERT_WITHOUT_FOLD_FIT = { inertWithout: "snapFoldToColumns" } as const;

/** Why a host with the favourite track still passes no utility header node. */
const UTILITY_HEADER_HIDES_LABEL =
  "A supplied node wins over the labelled fallback, so passing one here made `leadingUtilityLabel` inert and left the favourite `columnheader` with no accessible name at all. The header is visually blank either way; omitting it is what keeps the column named.";

const NO_UTILITY_TRACK =
  "There is no leading utility control on this table — no favourite star and no per-row affordance ahead of the name — so the track it would name or fill is not declared in this surface's grid template.";

/** The board's lead track is flexible too, so the resize pair is unanswerable. */
const FLEXIBLE_LEAD_TRACK_CLAIM = {
  notSupported:
    "The board's lead track is `minmax(350px, 1fr)` and flexes with the viewport. The resize seam adjusts and folds back a PIXEL width, which this body holds nowhere and could not put back into a flexible track.",
} as const;

const FLEXIBLE_LEAD_TRACK =
  "The lead track is `minmax(300px, 1fr)` and flexes with the viewport. The resize seam adjusts and folds back a PIXEL width, which this surface holds nowhere and could not put back into a flexible track.";

const CLOSED_KEYBOARD_MODEL =
  "This table ships the pre-ISS-8930 keyboard model: its header row is outside the arrow walk and every control in a cell keeps its own native tab stop. Opening either here would change what a keyboard user reaches, with no gate on this surface to open it behind.";

/**
 * The half of {@link CLOSED_KEYBOARD_MODEL} that is still true on Branches. That
 * surface passes `navigableHeaderCells` unconditionally — ISS-10245 retired
 * `grid-table-v2-navigable-header-cells` ENABLED, so it is no longer a gate the
 * surface reads — and the header-row clause therefore does not describe it.
 * Repeating that clause here would contradict the module it explains.
 */
const NATIVE_CELL_TAB_STOPS =
  "Every control in a branch row keeps its own native tab stop. Folding them behind one roving cell stop would change what a keyboard user reaches on this table, and this surface reads no gate it could open that behind.";

const NO_BAND_GLYPH =
  "The bands this table cuts are named by a person, a repository or a review state, and this surface holds no per-band glyph for any of them. The band's word is what distinguishes it, which is the reading a hue or an icon alone could not carry anyway.";

/** The two tables that let the grid remember their band collapse. */
const EPHEMERAL_BAND_COLLAPSE =
  "Band collapse on this table lives only as long as the table is mounted — nothing here persists it, restores it from a link, or shares it with a second view of the same bands — so the grid's own state IS this surface's answer, and a port would be a second copy of one fact.";

/**
 * The three tri-state fields that are only read when the checkbox renders, and
 * the clear-sort callback that is only reachable from a `leadingSortOptions`
 * item's third press. Declared against the companion the guard can CHECK is
 * withheld, rather than a sentence a reader has to grade.
 */
const INERT_WITHOUT_SELECT_ALL = { inertWithout: "showSelectAll" } as const;
const HEADER_SELECT_ALL_REMOVED = {
  notSupported:
    "ISS-13007 removes the header checkbox from this list; row selection and Cmd/Ctrl+A remain through the row-selection props and `onSelectAllRows`.",
} as const;
const INERT_WITHOUT_SORT_OPTIONS = {
  inertWithout: "leadingSortOptions",
} as const;

/** The two tables whose lead header already opens the shared actions menu. */
const LEAD_HEADER_OWNED_BY_ACTIONS_MENU =
  "This table's lead header already opens the shared column-actions menu, which owns its sort. A second dropdown hung on the same label would be two menus on one control, and the header resolves the actions menu first, so the list would never open.";

const NO_EXTRA_ROWS =
  "Nothing on this surface renders between or after the rows — no inline create, no per-row expansion panel, no footer row inside the table body — so the slot would be handed nothing to paint.";

/**
 * ISS-9313's two NARROWING props. Both default to permissive — absent, every
 * ordered column moves and every column the caller seeded a width for resizes —
 * so an omission here withholds no affordance from anyone; supplying one would
 * TAKE a drag away.
 *
 * Phase 06 (ISS-9316) put `resolveColumnLayout` behind the Branches list, so
 * Branches answers both with its own reasons below and no longer shares these.
 * What is left is not one set of surfaces but two, because the two props were
 * never on the same tables to begin with: {@link NO_PER_COLUMN_MOVABILITY} is
 * Sessions and the artifact sandbox, and {@link NO_PER_COLUMN_RESIZABILITY} is
 * those two plus the project board.
 */
const NO_PER_COLUMN_MOVABILITY =
  "This table builds its column array by hand and declares no per-column movability, so every ordered column is already the user's to move. Naming a subset here would take the drag off columns nothing on this surface has declared fixed.";

const NO_PER_COLUMN_RESIZABILITY =
  "The resizable set on this table IS the width map this surface seeds, and there is no separate per-column resizability fact behind it to narrow that with. A list here could only restate the map or withhold a drag no declaration asks for.";

/**
 * ISS-9316's answer for Branches resizability, which it reads off its registry
 * and still does not pass.
 *
 * `resolveColumnLayout` emits the list, but for this registry it comes out as
 * EVERY visible column: no Branches column declares `resizable: false`, and the
 * capability defaults to true. Passing the emitted list would restate the
 * permissive default under a narrowing prop. (Movability is passed since
 * ISS-12663, to keep the drag off custom-field columns.)
 */
const REGISTRY_DECLARES_NO_UNRESIZABLE_COLUMN =
  "Every column in the Branches registry resolves resizable and carries a declared width, so the emitted list is exactly the width map the grid already intersects a resize handle against. Passing it would restate that map, and a subset would withhold a drag no declaration asks for.";

/** ISS-9555's resume key, on the two tables that remember no row to resume on. */
const NO_KEYBOARD_RESUME =
  "Nothing on this surface records which row a reader left the table from, so there is no remembered row for a resume key to name — and no gate here to open a resume behind. Composing a key anyway would move the tab stop to a row this table chose rather than one the reader did.";

/**
 * ISS-10476's list table. Its four data columns are priority, owner, due date
 * and updated — a glyph-plus-word, an avatar-plus-name and two dates — none of
 * which is a bare scalar whose digits a value alignment would line up.
 */
const NO_VALUE_COLUMN_ALIGNMENT =
  "Every data column on this table paints a composite — an icon beside a word, an avatar beside a name, a formatted date — rather than a bare scalar, so there are no digits to align a column on and the option would only shift composites off their own baseline.";

const PROJECT_REGROUP_OWNED_BY_BOARD =
  "Reassigning a project's band is the BOARD's affordance on this screen — a card dragged between lanes, which is the gesture that reads as a move. Accepting a drop on a list row as well would give one fact two gestures, and the list's rows are links to the project rather than drag handles.";

const PROJECTS_LEAD_WIDTH_OWNED_BY_TEMPLATE =
  "This table composes its own `gridTemplateColumns` from the lead width its caller passes, so the lead track is already sized before the grid sees it. Passing the number again would be a second declaration of one width, and the grid's copy would not be the one the template used.";

const INERT_WITHOUT_UTILITY_TRACK = {
  inertWithout: "renderLeadingUtility",
} as const;

/**
 * ISS-12288's window is over ONE flat row index, so the primitive declines it
 * outright for a grouped body: a band header and a `renderAfterGroup` row are
 * not one data row tall, and each band is its own `rowgroup`.
 */
const INERT_UNDER_GROUPING = { inertUnder: "groups" } as const;

const base = (
  hostPath: string,
  capabilities: HostCapabilityLedger["capabilities"],
  component: Pick<
    HostCapabilityLedger,
    "componentModule" | "componentName" | "componentPath"
  > = {
    componentModule: GRID_TABLE_V2_COMPONENT_MODULE,
    componentName: GRID_TABLE_V2_COMPONENT_NAME,
    componentPath: GRID_TABLE_V2_COMPONENT_PATH,
  }
): HostCapabilityLedger => ({
  capabilities: {
    cardRender: {
      notSupported:
        component.componentName === PRODUCT_GRID_TABLE_V2_COMPONENT_NAME
          ? "Any card fallback on this mount is ProductGridTableV2's `cardCompatibility` adapter, which owns the captured-main cards; a direct `cardRender` beside it would be a second card renderer for one list."
          : "This table has no card projection: at narrow widths it renders the grid's own one-column list.",
    },
    getCardSelectionLabel: { inertWithout: "cardRender" },
    rowDragPreviewLabel: {
      notSupported:
        "This table offers no before, inside or after row placement, and the grip-and-title preview belongs to row placement; any band move here keeps the browser's own drag image.",
    },
    canDropOnRow: { inertWithout: "onRowDrop" },
    onRowDrop: {
      notSupported:
        "This table provides no before, inside or after row-placement operation; any group drop changes the destination band's field instead.",
    },
    rowDragHandleOnly: {
      notSupported:
        "This table provides no explicit row drag handle. Its native row drag region remains the entry point for any supported group move.",
    },
    staticTableSemantics: {
      notSupported:
        "This surface is an interactive grid or treegrid with a roving keyboard contract; static table roles would change how its rows and cells are navigated.",
    },
    preserveMeasuredContainer: {
      notSupported:
        "The surface does not control GridTableV2's responsive measured-frame transition: ProductGridTableV2 supplies the opt-in internally for auto mode, while a direct auto grid already retains its measured frame.",
    },
    ...capabilities,
  },
  ...component,
  hostPath,
  kinds: GRID_TABLE_V2_CAPABILITY_KINDS,
});

const productBase = (
  hostPath: string,
  capabilities: HostCapabilityLedger["capabilities"]
): HostCapabilityLedger =>
  base(hostPath, capabilities, {
    componentModule: PRODUCT_GRID_TABLE_V2_COMPONENT_MODULE,
    componentName: PRODUCT_GRID_TABLE_V2_COMPONENT_NAME,
    componentPath: PRODUCT_GRID_TABLE_V2_COMPONENT_PATH,
  });

/**
 * The Sessions grid, which both Sessions hosts mount. It wires the widest set:
 * narrow rows, grouping, selection, resize, the favourite track, and the three
 * keyboard/interaction gates it reads for itself.
 */
export const SESSIONS_GRID_LEDGER = productBase(
  "packages/app/agents/components/sessions/sessions-list-grid-v2.tsx",
  {
    alignValuesToColumn: SUPPLIED,
    allSelected: HEADER_SELECT_ALL_REMOVED,
    canDragRow: {
      notSupported:
        "Every row in this table is a Session governed by the same grouped-move authority, so the surface holds no per-row drag distinction for a predicate to express when group dropping is available.",
    },
    canDropOnGroup: {
      notSupported:
        "Every visible destination is derived from the same writable Session field and is valid for every draggable row, so this surface has no row-and-band refusal to express.",
    },
    collapseRowLabel: INERT_WITHOUT_LINEAGE,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    defaultExpandedRowIds: INERT_WITHOUT_LINEAGE,
    enableRowRangeDrag: SUPPLIED,
    expandRowLabel: INERT_WITHOUT_LINEAGE,
    foldFitSettleMs: SUPPLIED,
    getChildren: { notSupported: NO_ROW_LINEAGE },
    groupCollapse: SUPPLIED,
    groupIcon: {
      notSupported:
        "The grouping dimension is named in the section header's own label here; this surface carries no per-dimension icon set to draw one from, and inventing one would put a glyph on Sessions that no other grouped view has.",
    },
    groups: SUPPLIED,
    headerActions: SUPPLIED,
    isRowSelected: SUPPLIED,
    leadingColumnWidth: SUPPLIED,
    leadingSortKey: SUPPLIED,
    leadingSortOptions: {
      notSupported: LEAD_HEADER_OWNED_BY_ACTIONS_MENU,
    },
    leadingTooltip: SUPPLIED,
    // Not `inertWithout: "renderLeadingUtility"` — this surface DOES supply
    // that, so the track exists. The inability is specific and was found in
    // review: a supplied node WINS over the labelled fallback in `GridTableV2`.
    leadingUtilityHeader: {
      notSupported: UTILITY_HEADER_HIDES_LABEL,
    },
    leadingUtilityLabel: SUPPLIED,
    mode: SUPPLIED,
    movableColumnIds: { notSupported: NO_PER_COLUMN_MOVABILITY },
    navigableHeaderCells: SUPPLIED,
    onClearSort: INERT_WITHOUT_SORT_OPTIONS,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onGroupDrop: SUPPLIED,
    onLeadingColumnWidthChange: SUPPLIED,
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowExpandedChange: { notSupported: NO_ROW_LINEAGE },
    onRowKeyboardNavigate: SUPPLIED,
    onRowRangeDrag: SUPPLIED,
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: HEADER_SELECT_ALL_REMOVED,
    onSelectAllRows: SUPPLIED,
    onSort: SUPPLIED,
    pinLeadColumn: SUPPLIED,
    // ISS-9555. SUPPLIED as a value that is `undefined` while
    // `sessions-focus-restoration` is closed: the gate lives at the surface's
    // one read site above this grid, so what arrives here is a resume key or
    // nothing, never a flag.
    preferredActiveCellKey: SUPPLIED,
    renderAfterGroup: SUPPLIED,
    renderAfterItem: {
      notSupported:
        "Sessions inline create renders between groups and after the list, not after each row; this surface has no per-row expansion panel or body footer to paint in that slot.",
    },
    renderAfterRows: SUPPLIED,
    renderLeadingUtility: SUPPLIED,
    renderLeadingUtilityInWide: SUPPLIED,
    renderNarrowTrailingAction: {
      notSupported:
        "The narrow Session status is part of its lead, and Favorite is already the leading utility. This surface owns no separate trailing row action to pass.",
    },
    resizableColumnIds: { notSupported: NO_PER_COLUMN_RESIZABILITY },
    rowExpansion: { notSupported: NO_ROW_LINEAGE },
    showGroupCounts: SUPPLIED,
    showSelectAll: HEADER_SELECT_ALL_REMOVED,
    // ISS-4889/ISS-4906. The declared Sessions column set is ~1,000px wider than
    // the content area both hosts render it in, so the fold is this table's
    // normal state rather than an edge case.
    snapFoldToColumns: SUPPLIED,
    someSelected: HEADER_SELECT_ALL_REMOVED,
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    suppressCellTabStops: SUPPLIED,
    trailingHeader: SUPPLIED,
    virtualizeRows: SUPPLIED,
  }
);

/**
 * The Branches list. It supplies the shared narrow-row projection and the one
 * CONDITIONAL capability in the whole audit,
 * `pinLeadColumn`, which this grid body (ISS-9317 moved it out of the surface
 * file into `branches-grid-v2.tsx`) passes on one of its two mounts behind its
 * own live gate.
 *
 * ISS-9676 gave it GROUPING, so "no grouping" is gone from that sentence: it
 * bands by author, repository or PR / review state, over the rows the table is
 * rendering, and passes `showGroupCounts: false` because `items` is one server
 * page in bounded List mode. What it still does not supply is a per-band glyph
 * (`groupIcon`), a drop target (`onGroupDrop`) or an after-band slot
 * (`renderAfterGroup`) — each classified on its own reason below.
 */
export const BRANCHES_GRID_LEDGER = productBase(
  "packages/app/branches/components/branches-grid-v2.tsx",
  {
    alignValuesToColumn: SUPPLIED,
    allSelected: HEADER_SELECT_ALL_REMOVED,
    canDragRow: { inertWithout: "onGroupDrop" },
    canDropOnGroup: { inertWithout: "onGroupDrop" },
    collapseRowLabel: INERT_WITHOUT_LINEAGE,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    defaultExpandedRowIds: INERT_WITHOUT_LINEAGE,
    enableRowRangeDrag: SUPPLIED,
    expandRowLabel: INERT_WITHOUT_LINEAGE,
    foldFitSettleMs: INERT_WITHOUT_FOLD_FIT,
    getChildren: { notSupported: NO_ROW_LINEAGE },
    // ISS-9582: collapse is saved-view and link state here, handed to the grid
    // through the port so a restored view and a shared link reopen the same bands.
    groupCollapse: SUPPLIED,
    // ISS-9676: the three grouping dimensions are Author, Repository and
    // PR / review state, and none carries a per-band glyph this surface holds.
    // The band's WORD is what tells them apart, which is also why a hue-only
    // band marker would fail WCAG 1.4.1 here.
    groupIcon: { notSupported: NO_BAND_GLYPH },
    groups: SUPPLIED,
    headerActions: {
      notSupported:
        "Filtering and grouping live in this surface's own toolbar, which owns the branch facets; a per-column menu here would be a second, narrower filter model over the same list.",
    },
    isRowSelected: SUPPLIED,
    // The lead track is `minmax(300px, 1fr)`: a flexible track, not a pixel
    // width. The resize seam needs a number it can adjust and fold back.
    leadingColumnWidth: { notSupported: FLEXIBLE_LEAD_TRACK },
    leadingSortKey: SUPPLIED,
    leadingSortOptions: {
      notSupported:
        "The lead column is a branch name and that is the only identity this row carries on that track — no id, no second title — so an options list would offer one key and read as a menu with nothing to choose.",
    },
    leadingTooltip: {
      notSupported:
        "The lead column is `Name` over a branch name, which needs no gloss; this surface holds no per-column help copy to draw one from, and writing one here would be product copy rather than wiring.",
    },
    leadingUtilityHeader: {
      notSupported: UTILITY_HEADER_HIDES_LABEL,
    },
    leadingUtilityLabel: SUPPLIED,
    mode: SUPPLIED,
    // ISS-12663: passed once custom-field columns show, to keep the drag off
    // them (only the built-in order persists); absent otherwise.
    movableColumnIds: SUPPLIED,
    navigableHeaderCells: SUPPLIED,
    onClearSort: INERT_WITHOUT_SORT_OPTIONS,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    // ISS-9676: a drop WRITES the dimension the band names, and a branch's
    // author, repository and PR state are all facts of the repository — none is
    // settable from this list, so every band would refuse.
    onGroupDrop: {
      notSupported:
        "Branches groups by author, repository and PR / review state, and all three are facts the repository reports rather than fields this product sets. A drop onto a band would have nothing to write.",
    },
    onLeadingColumnWidthChange: { notSupported: FLEXIBLE_LEAD_TRACK },
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowExpandedChange: { notSupported: NO_ROW_LINEAGE },
    onRowKeyboardNavigate: SUPPLIED,
    onRowRangeDrag: SUPPLIED,
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: HEADER_SELECT_ALL_REMOVED,
    onSelectAllRows: SUPPLIED,
    onSort: SUPPLIED,
    /**
     * The audit's one gated capability, and the reason `gatedOn` exists: this
     * surface returns a pinned mount or an unpinned one off
     * `BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY`, so a reader with that gate
     * closed does not get the pin. ISS-9659 retired the Sessions twin ENABLED;
     * when this one retires in either direction the claim reddens on its own.
     */
    pinLeadColumn: { gatedOn: "BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY" },
    preferredActiveCellKey: { notSupported: NO_KEYBOARD_RESUME },
    renderAfterGroup: { notSupported: NO_EXTRA_ROWS },
    renderAfterItem: { notSupported: NO_EXTRA_ROWS },
    renderAfterRows: { notSupported: NO_EXTRA_ROWS },
    // ISS-12959: the narrow row carries no Tags, so nothing fills the utility.
    renderLeadingUtility: SUPPLIED,
    renderLeadingUtilityInWide: SUPPLIED,
    renderNarrowTrailingAction: SUPPLIED,
    resizableColumnIds: {
      notSupported: REGISTRY_DECLARES_NO_UNRESIZABLE_COLUMN,
    },
    rowExpansion: { notSupported: NO_ROW_LINEAGE },
    // ISS-9676: PASSED, and passed `false`. `items` is one server page in
    // bounded List mode, so a per-band count beside a "1–25 of 400" footer
    // would read as a population this surface never counted.
    showGroupCounts: SUPPLIED,
    showSelectAll: HEADER_SELECT_ALL_REMOVED,
    snapFoldToColumns: {
      notSupported:
        "The shared grid uses the one-column Name projection below the viewport breakpoint and the complete grid above it. Whole-column fold fitting would create a second responsive policy over the same selected columns.",
    },
    someSelected: HEADER_SELECT_ALL_REMOVED,
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    suppressCellTabStops: { notSupported: NATIVE_CELL_TAB_STOPS },
    // ISS-12663: the Add field header, when the host can create a field.
    trailingHeader: SUPPLIED,
    virtualizeRows: INERT_UNDER_GROUPING,
  }
);

/**
 * `GenericArtifactTableDemo`, the artifact-surface sandbox. Not reachable from
 * any product route — its only consumers are Storybook suites — but it renders
 * the primitive from a non-fixture path, so the discovery check names it and it
 * is ledgered rather than excluded. Fail-closed: if it is ever promoted, the
 * audit already exists.
 */
export const ARTIFACT_SURFACE_GRID_LEDGER = base(
  "packages/app/shared/components/generic-artifact-surface/generic-artifact-table.tsx",
  {
    alignValuesToColumn: SUPPLIED,
    allSelected: INERT_WITHOUT_SELECT_ALL,
    canDragRow: SUPPLIED,
    canDropOnGroup: SUPPLIED,
    collapseRowLabel: INERT_WITHOUT_LINEAGE,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    defaultExpandedRowIds: INERT_WITHOUT_LINEAGE,
    enableRowRangeDrag: INERT_WITHOUT_RANGE_DRAG,
    expandRowLabel: INERT_WITHOUT_LINEAGE,
    foldFitSettleMs: INERT_WITHOUT_FOLD_FIT,
    getChildren: { notSupported: NO_ROW_LINEAGE },
    groupCollapse: { notSupported: EPHEMERAL_BAND_COLLAPSE },
    groupIcon: {
      notSupported:
        "Grouping here is chosen from any column at run time, so there is no fixed dimension for an icon to stand for and no icon set behind the demo's fixture columns.",
    },
    groups: SUPPLIED,
    headerActions: SUPPLIED,
    isRowSelected: SUPPLIED,
    leadingColumnWidth: SUPPLIED,
    leadingSortKey: SUPPLIED,
    leadingSortOptions: {
      notSupported: LEAD_HEADER_OWNED_BY_ACTIONS_MENU,
    },
    leadingTooltip: SUPPLIED,
    leadingUtilityHeader: {
      notSupported:
        "The favourite track's header is visually blank, and a supplied node would win over the labelled fallback and leave that `columnheader` unnamed — the same accessibility trap the Sessions grid documents.",
    },
    leadingUtilityLabel: SUPPLIED,
    mode: {
      notSupported:
        "The `auto` default is the responsive behaviour this sandbox wants; naming a fixed mode would pin a layout the demo does not choose.",
    },
    movableColumnIds: { notSupported: NO_PER_COLUMN_MOVABILITY },
    navigableHeaderCells: { notSupported: CLOSED_KEYBOARD_MODEL },
    onClearSort: INERT_WITHOUT_SORT_OPTIONS,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onGroupDrop: SUPPLIED,
    onLeadingColumnWidthChange: SUPPLIED,
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowExpandedChange: { notSupported: NO_ROW_LINEAGE },
    onRowKeyboardNavigate: SUPPLIED,
    onRowRangeDrag: {
      notSupported:
        "This sandbox holds its selection in local state with click, toggle and select-all; it has no range model behind a pointer drag, so a drag would report rows nothing here resolves into a range.",
    },
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: INERT_WITHOUT_SELECT_ALL,
    onSelectAllRows: SUPPLIED,
    onSort: SUPPLIED,
    pinLeadColumn: {
      notSupported:
        "This sandbox exists to demonstrate the scrolling grid itself; pinning the lead column would hold part of that demonstration out of the scroll it is there to show.",
    },
    preferredActiveCellKey: { notSupported: NO_KEYBOARD_RESUME },
    renderAfterGroup: { notSupported: NO_EXTRA_ROWS },
    renderAfterItem: { notSupported: NO_EXTRA_ROWS },
    renderAfterRows: { notSupported: NO_EXTRA_ROWS },
    renderLeadingUtility: SUPPLIED,
    renderLeadingUtilityInWide: {
      notSupported:
        "This table's leading utility is the wide Favorite track as well as the narrow trailing control, so limiting it to the narrow lead would remove a shipped wide column.",
    },
    renderNarrowTrailingAction: {
      notSupported:
        "This sandbox has an editable identity lead and a Favorite leading utility, but no separate row-actions control to place in the narrow trailing slot.",
    },
    resizableColumnIds: { notSupported: NO_PER_COLUMN_RESIZABILITY },
    rowExpansion: { notSupported: NO_ROW_LINEAGE },
    showGroupCounts: {
      notSupported:
        "This surface holds the whole fixture collection rather than a page of it, so a group's count IS its population and the default reading is the correct one.",
    },
    showSelectAll: {
      notSupported:
        "This sandbox holds selection in local state to demonstrate the row treatment, and there is no bulk action behind it. A header control that selected the whole fixture collection would offer a gesture with nowhere to go.",
    },
    snapFoldToColumns: {
      notSupported:
        "This sandbox exists to demonstrate the scrolling grid itself, fold and all; snapping the fold onto a column boundary would remove the half-cut track the demonstration is there to show.",
    },
    someSelected: INERT_WITHOUT_SELECT_ALL,
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    suppressCellTabStops: { notSupported: CLOSED_KEYBOARD_MODEL },
    trailingHeader: SUPPLIED,
    virtualizeRows: INERT_UNDER_GROUPING,
  }
);

/**
 * The production-bound Generic Artifact preview promoted by ISS-6251. The
 * prototype route owns mock state only; this portable package surface owns the
 * shared grid, narrow-row projection, grouping, editing, and responsive behavior.
 */
export const PORTABLE_ARTIFACT_GRID_LEDGER = productBase(
  "packages/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-sections.tsx",
  {
    canDropOnRow: SUPPLIED,
    onRowDrop: SUPPLIED,
    rowDragHandleOnly: {
      notSupported:
        "PRD-723 finding 723-F2 keeps the visible handle, eligible title whitespace and the title link equivalent row-drag origins.",
    },
    rowDragPreviewLabel: SUPPLIED,
    getCardSelectionLabel: SUPPLIED,
    enableRowRangeDrag: INERT_WITHOUT_RANGE_DRAG,
    mode: SUPPLIED,
    onRowRangeDrag: {
      notSupported:
        "Pointer motion over a row is this surface's native row drag for band moves and hierarchy placement, so the range-drag gesture on that same motion is not wired here; the checkboxes select.",
    },
    alignValuesToColumn: {
      notSupported:
        "This surface's column registry carries no resolved value-alignment map; each semantic cell owns its own layout, so the host has no column-level alignment decision to pass.",
    },
    allSelected: INERT_WITHOUT_SELECT_ALL,
    canDragRow: SUPPLIED,
    canDropOnGroup: SUPPLIED,
    collapseRowLabel: INERT_WITHOUT_LINEAGE,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    defaultExpandedRowIds: INERT_WITHOUT_LINEAGE,
    expandRowLabel: INERT_WITHOUT_LINEAGE,
    foldFitSettleMs: INERT_WITHOUT_FOLD_FIT,
    getChildren: {
      notSupported:
        "The surface resolves artifact hierarchy into one flat ordered list before the grid and renders its disclosure and indentation in the lead cell. It has no parent-child graph at this boundary for the grid to flatten again.",
    },
    groupCollapse: SUPPLIED,
    groupIcon: {
      notSupported:
        "Grouping is selected at run time across status, kind, owner and custom fields, and this surface carries no one icon vocabulary that can truthfully identify every possible band.",
    },
    groups: SUPPLIED,
    headerActions: SUPPLIED,
    isRowSelected: SUPPLIED,
    leadingColumnWidth: SUPPLIED,
    leadingSortKey: SUPPLIED,
    leadingSortOptions: {
      notSupported: LEAD_HEADER_OWNED_BY_ACTIONS_MENU,
    },
    leadingTooltip: SUPPLIED,
    leadingUtilityHeader: {
      notSupported:
        "The favourite track is visually blank. Supplying a node would override the labelled fallback and leave that column header unnamed, so the host supplies the accessible label instead.",
    },
    leadingUtilityLabel: SUPPLIED,
    movableColumnIds: SUPPLIED,
    navigableHeaderCells: { notSupported: CLOSED_KEYBOARD_MODEL },
    onClearSort: INERT_WITHOUT_SORT_OPTIONS,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onGroupDrop: SUPPLIED,
    onLeadingColumnWidthChange: SUPPLIED,
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowExpandedChange: {
      notSupported:
        "Hierarchy expansion is owned by the preview controller before rows reach the grid, so the primitive never expands a row and has no expansion change to report back.",
    },
    onRowKeyboardNavigate: SUPPLIED,
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: INERT_WITHOUT_SELECT_ALL,
    onSelectAllRows: SUPPLIED,
    onSort: SUPPLIED,
    pinLeadColumn: {
      notSupported:
        "The approved portable preview scrolls its complete desktop column set and has no pinned-name treatment. Pinning only this promoted consumer would introduce a layout behavior absent from its design source.",
    },
    preferredActiveCellKey: { notSupported: NO_KEYBOARD_RESUME },
    renderAfterGroup: SUPPLIED,
    renderAfterItem: SUPPLIED,
    renderAfterRows: SUPPLIED,
    renderLeadingUtility: SUPPLIED,
    renderLeadingUtilityInWide: SUPPLIED,
    renderNarrowTrailingAction: {
      notSupported:
        "The portable narrow status is already inside renderLead, while the host-supplied utility or fallback Favorite owns the other row control. This grid has no separate trailing row-actions renderer.",
    },
    resizableColumnIds: SUPPLIED,
    rowExpansion: {
      notSupported:
        "The preview controller owns its pre-flattened hierarchy and disclosure state. The grid receives no child graph, so its row-expansion port has no lineage to operate on.",
    },
    showGroupCounts: {
      notSupported:
        "The preview holds the complete in-memory mock population, so each band's rendered length is its truthful count and the primitive's default count behavior is already the required one.",
    },
    showSelectAll: {
      notSupported:
        "The approved toolbar and bulk bar expose no select-all control. A header checkbox would add a new selection action and population rule that the design source does not define.",
    },
    snapFoldToColumns: {
      notSupported:
        "This responsive surface keeps its declared desktop tracks until the shared viewport breakpoint selects the one-column Name projection. It has no intermediate whole-column fold mode or settled-width policy to preserve.",
    },
    someSelected: INERT_WITHOUT_SELECT_ALL,
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    suppressCellTabStops: { notSupported: CLOSED_KEYBOARD_MODEL },
    trailingHeader: SUPPLIED,
    virtualizeRows: INERT_UNDER_GROUPING,
  }
);

/**
 * The project board's grouped body (ISS-9335) — the first consumer to take the
 * grid's row LINEAGE, and the first to own its band collapse and row expansion
 * rather than let the grid remember them.
 *
 * It is a narrow mount by design: the board's toolbar, column menu, filters and
 * pagination all live in the view ABOVE this body, so nearly everything this
 * ledger answers is "that fact belongs to the view, not to the table". What it
 * genuinely cannot do is the rest — this board has no alternate row design,
 * no custom fields, and no row-reorder drag inside a grouped view, which is a product
 * state (`RankInteractionMode.DisabledGrouped`) rather than an omission.
 */
export const PROJECT_BOARD_GRID_LEDGER = productBase(
  "packages/app/documents/components/table/documents-grid-groups-body.tsx",
  {
    allSelected: SUPPLIED,
    getCardSelectionLabel: SUPPLIED,
    rowDragPreviewLabel: SUPPLIED,
    alignValuesToColumn: {
      notSupported:
        "This body builds its column array by hand, so no column carries a resolved alignment for the grid to publish to the cell inside it. Opening the seam over columns that declare none would move nothing and claim a resolution this surface has not made.",
    },
    canDragRow: SUPPLIED,
    canDropOnGroup: { inertWithout: "onGroupDrop" },
    canDropOnRow: SUPPLIED,
    collapseRowLabel: SUPPLIED,
    columnOrder: SUPPLIED,
    columnWidths: {
      notSupported:
        "The board's tracks are a fixed template (a flexible lead plus 124px data columns); it stores no per-column pixel width, so there is no measured base for a resize handle to adjust from or fold back into.",
    },
    defaultExpandedRowIds: { inertUnder: "rowExpansion" },
    enableRowRangeDrag: INERT_WITHOUT_RANGE_DRAG,
    expandRowLabel: SUPPLIED,
    foldFitSettleMs: INERT_WITHOUT_FOLD_FIT,
    getChildren: SUPPLIED,
    groupCollapse: SUPPLIED,
    groupIcon: {
      notSupported:
        "Every band on this board carries its OWN glyph — a status mark, a priority mark, or the assignee's avatar — on the band itself. One dimension-wide icon would have to stand for all of them and would contradict the per-band mark beside it.",
    },
    groups: SUPPLIED,
    headerActions: {
      notSupported:
        "The board's filter, group and column-visibility controls are the page toolbar's, over the whole project rather than one column. A per-column menu here would be a second, narrower model of the same three controls.",
    },
    isRowSelected: SUPPLIED,
    leadingColumnWidth: FLEXIBLE_LEAD_TRACK_CLAIM,
    // Superseded, not withheld: the board sorts its lead column by three keys,
    // and with an options list present the single key is never read.
    leadingSortKey: { inertUnder: "leadingSortOptions" },
    leadingSortOptions: SUPPLIED,
    leadingTooltip: {
      notSupported:
        "The lead column is `Name` over an artifact title and slug, which needs no gloss; the board holds no per-column help copy, and writing one here would be product copy rather than wiring.",
    },
    leadingUtilityHeader: { notSupported: NO_UTILITY_TRACK },
    leadingUtilityLabel: { notSupported: NO_UTILITY_TRACK },
    mode: {
      notSupported:
        "The `auto` default IS the board's rule — one-column Name rows below the viewport breakpoint, the full grid above it — and this body has no reason to pin one layout its caller did not ask for.",
    },
    movableColumnIds: SUPPLIED,
    navigableHeaderCells: { notSupported: CLOSED_KEYBOARD_MODEL },
    onClearSort: SUPPLIED,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: {
      notSupported:
        "There is no stored width for a resize to write: the board's tracks are a fixed template, so a reported width would have nowhere to be kept and nothing to apply it to on the next render.",
    },
    onGroupDrop: {
      notSupported:
        "A drop would write the artifact field the band names — its status, priority or assignee — and every one of those is an inline edit the row's own cell already owns, with its own confirmation and permissions. A second write path past those controls is a product decision nobody has taken.",
    },
    onLeadingColumnWidthChange: FLEXIBLE_LEAD_TRACK_CLAIM,
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowDrop: SUPPLIED,
    onRowExpandedChange: {
      notSupported:
        "Expansion is written through `rowExpansion.setExpanded`, which is where this body's host persists it. A change listener beside it would be a second notification of one event, and the two could be handled differently.",
    },
    onRowKeyboardNavigate: SUPPLIED,
    onRowRangeDrag: {
      notSupported:
        "The board resolves no row RANGE: its bulk bar operates on the checkbox set, and there is no anchor row for a drag or a Shift-click to extend from, so a reported range would name rows nothing here could select.",
    },
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: SUPPLIED,
    onSelectAllRows: SUPPLIED,
    onSort: SUPPLIED,
    pinLeadColumn: {
      notSupported:
        "The board has never pinned its Name column, and pinning it here would change the scroll behaviour of one of the view's two bodies and not the other — a difference a reader would meet by toggling a gate that is not about pinning.",
    },
    preferredActiveCellKey: { notSupported: NO_KEYBOARD_RESUME },
    renderAfterGroup: { notSupported: NO_EXTRA_ROWS },
    renderAfterItem: { notSupported: NO_EXTRA_ROWS },
    renderAfterRows: { notSupported: NO_EXTRA_ROWS },
    renderLeadingUtility: { notSupported: NO_UTILITY_TRACK },
    renderLeadingUtilityInWide: INERT_WITHOUT_UTILITY_TRACK,
    renderNarrowTrailingAction: {
      notSupported:
        "This grouped Documents body keeps Favorite and More inside its wrapping narrow renderLead. Moving that cluster into the shared fixed-line trailing slot would break the title wrap at 195px, and passing it twice would duplicate the actions.",
    },
    resizableColumnIds: { notSupported: NO_PER_COLUMN_RESIZABILITY },
    rowExpansion: SUPPLIED,
    showSelectAll: SUPPLIED,
    // The board's tracks are a fixed template — a flexible lead plus 124px data
    // columns — and it stores no per-column pixel width (see `columnWidths`
    // above). Snapping the fold to a column boundary needs a measured width to
    // fold back into, and this surface has none to read.
    snapFoldToColumns: {
      notSupported:
        "This board's column tracks are a fixed template rather than stored per-column widths, so there is no measured boundary for the fold to land on; snapping would have to invent a width this surface never records.",
    },
    someSelected: SUPPLIED,
    showGroupCounts: {
      notSupported:
        "Whether a band may state a number is decided per BAND here, by the population its host declares (ISS-4704) — a table-wide switch would either silence the bands that honestly know their size or let the ones that do not publish a page-local length.",
    },
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    suppressCellTabStops: { notSupported: CLOSED_KEYBOARD_MODEL },
    trailingHeader: {
      notSupported:
        "The board's columns come from its own visibility set; there is no custom-field store behind an artifact table, so there is no Add field action for the trailing slot to hold.",
    },
    virtualizeRows: INERT_UNDER_GROUPING,
  }
);

/**
 * The promoted Projects LIST table (ISS-10476), which renders the same rows the
 * project board does and is the second mount to read nested bands (ISS-10478).
 * It is a read-only projection: the row links out to the project, and every
 * mutation this screen offers is the board's or the host's, not this table's.
 */
export const PROJECTS_TABLE_GRID_LEDGER = productBase(
  "packages/app/projects/components/projects-table.tsx",
  {
    alignValuesToColumn: {
      notSupported: NO_VALUE_COLUMN_ALIGNMENT,
    },
    allSelected: HEADER_SELECT_ALL_REMOVED,
    canDragRow: { inertWithout: "onGroupDrop" },
    canDropOnGroup: { inertWithout: "onGroupDrop" },
    collapseRowLabel: INERT_WITHOUT_LINEAGE,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    defaultExpandedRowIds: INERT_WITHOUT_LINEAGE,
    enableRowRangeDrag: SUPPLIED,
    expandRowLabel: INERT_WITHOUT_LINEAGE,
    foldFitSettleMs: INERT_WITHOUT_FOLD_FIT,
    getChildren: { notSupported: NO_ROW_LINEAGE },
    groupCollapse: { notSupported: EPHEMERAL_BAND_COLLAPSE },
    groupIcon: { notSupported: NO_BAND_GLYPH },
    groups: SUPPLIED,
    headerActions: SUPPLIED,
    isRowSelected: SUPPLIED,
    leadingColumnWidth: {
      notSupported: PROJECTS_LEAD_WIDTH_OWNED_BY_TEMPLATE,
    },
    leadingSortKey: SUPPLIED,
    leadingSortOptions: { notSupported: LEAD_HEADER_OWNED_BY_ACTIONS_MENU },
    leadingTooltip: {
      notSupported:
        "The lead column is the project's name, and this table's own lead cell already carries the only tooltip that column needs — the completion ring's accessible name. A header tooltip explaining 'Project' would say less than the word.",
    },
    leadingUtilityHeader: INERT_WITHOUT_UTILITY_TRACK,
    leadingUtilityLabel: INERT_WITHOUT_UTILITY_TRACK,
    mode: {
      notSupported:
        "The one-column fallback this table supplies is chosen by the shared viewport breakpoint; nothing on this surface pins a mode, and forcing one would override the projection the reader's viewport actually has.",
    },
    movableColumnIds: { notSupported: NO_PER_COLUMN_MOVABILITY },
    navigableHeaderCells: { notSupported: CLOSED_KEYBOARD_MODEL },
    onClearSort: INERT_WITHOUT_SORT_OPTIONS,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onGroupDrop: { notSupported: PROJECT_REGROUP_OWNED_BY_BOARD },
    onLeadingColumnWidthChange: { notSupported: FLEXIBLE_LEAD_TRACK },
    onRenderedItemsChange: SUPPLIED,
    onRowClick: SUPPLIED,
    onRowExpandedChange: { notSupported: NO_ROW_LINEAGE },
    onRowKeyboardNavigate: SUPPLIED,
    onRowRangeDrag: SUPPLIED,
    onRowSelectionToggle: SUPPLIED,
    onSelectAll: HEADER_SELECT_ALL_REMOVED,
    onSelectAllRows: SUPPLIED,
    onSort: SUPPLIED,
    pinLeadColumn: {
      notSupported:
        "This table's four data columns fit at every wide viewport where the one-column projection is inactive, so there is nothing for a pinned lead to stay visible against — and pinning paints a tinted overlay the unpinned rows would not match.",
    },
    preferredActiveCellKey: { notSupported: NO_KEYBOARD_RESUME },
    renderAfterGroup: { notSupported: NO_EXTRA_ROWS },
    renderAfterItem: { notSupported: NO_EXTRA_ROWS },
    renderAfterRows: { notSupported: NO_EXTRA_ROWS },
    renderLeadingUtility: { notSupported: NO_UTILITY_TRACK },
    renderLeadingUtilityInWide: INERT_WITHOUT_UTILITY_TRACK,
    renderNarrowTrailingAction: SUPPLIED,
    resizableColumnIds: { notSupported: NO_PER_COLUMN_RESIZABILITY },
    rowExpansion: INERT_WITHOUT_LINEAGE,
    showGroupCounts: {
      notSupported:
        "This table receives the whole filtered population rather than a page of it, so a band's own row count IS its population and the grid's default count is already the honest number. Passing `false` would withhold a count that is not lying.",
    },
    showSelectAll: HEADER_SELECT_ALL_REMOVED,
    snapFoldToColumns: {
      notSupported:
        "The responsive transition this table can reach is the one-column Name projection, not a column boundary: its four data columns are all narrow and fixed, so there is no wide column whose partial reveal a snap would tidy.",
    },
    someSelected: HEADER_SELECT_ALL_REMOVED,
    sortBy: SUPPLIED,
    sortDir: SUPPLIED,
    suppressCellTabStops: { notSupported: CLOSED_KEYBOARD_MODEL },
    trailingHeader: {
      notSupported:
        "This table declares no trailing chrome column — no row-actions menu and no overflow slot after `Updated` — so there is no trailing track for a header to name.",
    },
    virtualizeRows: INERT_UNDER_GROUPING,
  }
);

/** The design shell's toolbar is mounted without `sortGrouping` (ISS-12586). */
const DESIGN_SHELL_NO_ORDERING =
  "This shell offers no ordering: its rows keep their fixture order and its toolbar is mounted without `sortGrouping`, so there is no sort state for a header to read or write.";

const DESIGN_SHELL_NO_SELECTION =
  "This shell holds no row selection: it offers no bulk action and no selected-row state, and its only per-row state is the favourite star in the utility track, so a selection callback would report rows nothing here acts on.";

const DESIGN_SHELL_FIXED_COLUMNS =
  "This shell's column order and widths are fixed by the `columnIds` each preview passes and the registry's default widths; it holds no order or width state, so a header drag or resize would report a change nothing here stores or folds back into its grid template.";

/**
 * `ArtifactListDesignShell` (ISS-12586), the Documents List and Issues List
 * design shell on the Branches list composition. Fixture rows only and no
 * production route, but it renders the primitive from a non-fixture path, so it
 * is ledgered rather than excluded, as the artifact sandbox above is.
 */
export const ARTIFACT_LIST_DESIGN_SHELL_GRID_LEDGER = base(
  "packages/app/documents/components/list-design/artifact-list-design-shell.tsx",
  {
    alignValuesToColumn: {
      notSupported:
        "Every column either preview shows resolves to the start edge: the one Number column, Comments, overrides back to Start and the design-only Assignee column declares none. The shell has no end-aligned value for the seam to carry.",
    },
    allSelected: INERT_WITHOUT_SELECT_ALL,
    canDragRow: { inertWithout: "onGroupDrop" },
    canDropOnGroup: { inertWithout: "onGroupDrop" },
    collapseRowLabel: INERT_WITHOUT_LINEAGE,
    columnOrder: { notSupported: DESIGN_SHELL_FIXED_COLUMNS },
    columnWidths: { notSupported: DESIGN_SHELL_FIXED_COLUMNS },
    defaultExpandedRowIds: INERT_WITHOUT_LINEAGE,
    enableRowRangeDrag: INERT_WITHOUT_RANGE_DRAG,
    expandRowLabel: INERT_WITHOUT_LINEAGE,
    foldFitSettleMs: INERT_WITHOUT_FOLD_FIT,
    getChildren: { notSupported: NO_ROW_LINEAGE },
    groupCollapse: { inertWithout: "groups" },
    groupIcon: { inertWithout: "groups" },
    groups: {
      notSupported:
        "This shell offers no grouping: its toolbar is mounted without `sortGrouping`, so there is no group-by menu and no dimension to cut bands from.",
    },
    headerActions: {
      notSupported:
        "Filtering lives in this shell's toolbar (the Status and Owner facets) and the shell has no sort or grouping to offer, so a per-column menu would be a second, narrower filter model over the same rows.",
    },
    isRowSelected: { notSupported: DESIGN_SHELL_NO_SELECTION },
    leadingColumnWidth: { notSupported: FLEXIBLE_LEAD_TRACK },
    leadingSortKey: { notSupported: DESIGN_SHELL_NO_ORDERING },
    leadingSortOptions: { notSupported: DESIGN_SHELL_NO_ORDERING },
    leadingTooltip: {
      notSupported:
        "The lead column is `Document` or `Issue` over an artifact title and slug, which needs no gloss; this shell holds no per-column help copy, and writing one here would be product copy rather than wiring.",
    },
    leadingUtilityHeader: {
      notSupported:
        "The favourite track's header is visually blank, and a supplied node would win over the labelled fallback and leave that `columnheader` unnamed, the same accessibility trap the Sessions grid documents.",
    },
    leadingUtilityLabel: SUPPLIED,
    mode: SUPPLIED,
    movableColumnIds: { inertWithout: "onColumnOrderChange" },
    navigableHeaderCells: SUPPLIED,
    onClearSort: INERT_WITHOUT_SORT_OPTIONS,
    onColumnOrderChange: { notSupported: DESIGN_SHELL_FIXED_COLUMNS },
    onColumnWidthChange: { notSupported: DESIGN_SHELL_FIXED_COLUMNS },
    onGroupDrop: { inertWithout: "groups" },
    onLeadingColumnWidthChange: { notSupported: FLEXIBLE_LEAD_TRACK },
    onRenderedItemsChange: { notSupported: DESIGN_SHELL_NO_SELECTION },
    onRowClick: {
      notSupported:
        "A row here has nowhere to open: its records are fixtures with no detail route, and the lead cell is plain text rather than a link, so a row activation would report a click nothing on this shell can act on.",
    },
    onRowExpandedChange: { notSupported: NO_ROW_LINEAGE },
    onRowKeyboardNavigate: { notSupported: DESIGN_SHELL_NO_SELECTION },
    onRowRangeDrag: { notSupported: DESIGN_SHELL_NO_SELECTION },
    onRowSelectionToggle: { notSupported: DESIGN_SHELL_NO_SELECTION },
    onSelectAll: INERT_WITHOUT_SELECT_ALL,
    onSelectAllRows: { notSupported: DESIGN_SHELL_NO_SELECTION },
    onSort: { notSupported: DESIGN_SHELL_NO_ORDERING },
    pinLeadColumn: {
      notSupported:
        "The Branches composition this shell follows pins its name column only on the open branch of its own gate, and this fixture-only shell reads no gate to split on, so it renders the unpinned mount.",
    },
    preferredActiveCellKey: { notSupported: NO_KEYBOARD_RESUME },
    renderAfterGroup: { inertWithout: "groups" },
    renderAfterItem: { notSupported: NO_EXTRA_ROWS },
    renderAfterRows: { notSupported: NO_EXTRA_ROWS },
    renderLeadingUtility: SUPPLIED,
    renderLeadingUtilityInWide: {
      notSupported:
        "The design shell's Favorite is a wide leading utility as well as a narrow control, so narrowing its placement would make the fixture diverge from the composition it demonstrates.",
    },
    renderNarrowTrailingAction: {
      notSupported:
        "This design shell exposes Favorite through its leading utility and declares no separate per-row actions control for a narrow trailing slot.",
    },
    resizableColumnIds: { inertWithout: "onColumnWidthChange" },
    rowExpansion: { notSupported: NO_ROW_LINEAGE },
    showGroupCounts: { inertWithout: "groups" },
    showSelectAll: { notSupported: DESIGN_SHELL_NO_SELECTION },
    snapFoldToColumns: {
      notSupported:
        "The Branches composition this shell follows uses the shared one-column projection at narrow viewports and its selected columns at wide viewports. Whole-column fold fitting would be a second responsive policy that composition does not have.",
    },
    someSelected: INERT_WITHOUT_SELECT_ALL,
    sortBy: { notSupported: DESIGN_SHELL_NO_ORDERING },
    sortDir: { notSupported: DESIGN_SHELL_NO_ORDERING },
    suppressCellTabStops: {
      notSupported:
        "Every control in an artifact row, the favourite star among them, keeps its own native tab stop. Folding them behind one roving cell stop would change what a keyboard user reaches, and this shell reads no gate to open that behind.",
    },
    trailingHeader: {
      notSupported:
        "This shell's grid template declares no trailing track and there is no custom-field store behind its fixture rows, so there is no Add field action for the trailing slot to hold.",
    },
    // PASSED, and passed `false`: ISS-12288's operator ruling accepted the
    // window's find-in-page cost for the Sessions list only.
    virtualizeRows: SUPPLIED,
  }
);

export const GRID_TABLE_V2_SURFACE_LEDGERS = [
  SESSIONS_GRID_LEDGER,
  SESSION_DETAIL_GRID_LEDGER,
  BRANCHES_GRID_LEDGER,
  ARTIFACT_SURFACE_GRID_LEDGER,
  PORTABLE_ARTIFACT_GRID_LEDGER,
  PROJECT_BOARD_GRID_LEDGER,
  PROJECTS_TABLE_GRID_LEDGER,
  PROJECT_ARTIFACT_TREE_GRID_LEDGER,
  ARTIFACT_LIST_DESIGN_SHELL_GRID_LEDGER,
];
