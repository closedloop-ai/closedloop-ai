/**
 * `GridTableV2`'s public API surface: the column, band, and prop types callers
 * write against.
 *
 * Split out of `grid-table-v2.tsx` (ISS-8921) because the two are different
 * jobs with different reasons to change — this file is the CONTRACT, that one is
 * the render — and because the component is held against a hard 1,000-line
 * ceiling that every new prop and its doc comment ate into. The component
 * re-exports the three public names, so nothing a caller imports moved.
 *
 * Types only, no runtime: the sibling `lib/` helpers can name a band without
 * taking an edge back to the component they were lifted out of.
 */

import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import type {
  TableGridHeaderV2Actions,
  TableGridHeaderV2SortOption,
} from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import type { ColumnAlignment } from "@closedloop-ai/design-system/lib/column-registry";
import type { GridChromeCellProps } from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import type { GridSelectionModifiers } from "@closedloop-ai/design-system/lib/grid-table-v2-selection";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

/** Runtime values for the grid's measured and explicitly forced layouts. */
export const GridTableV2Mode = {
  Auto: "auto",
  Compact: "compact",
  Expanded: "expanded",
} as const;
export type GridTableV2Mode =
  (typeof GridTableV2Mode)[keyof typeof GridTableV2Mode];

export type GridTableV2Column = {
  id: string;
  label: string;
  className?: string;
  /** When true (and `onSort` is provided), the header is a clickable sort control. */
  sortable?: boolean;
  /** Whether the column exposes Filter in its action menu. */
  filterable?: boolean;
  /** Whether the column exposes Group in its action menu. */
  groupable?: boolean;
  /** Optional help text shown via an info icon + tooltip in the column header. */
  tooltip?: string;
  /**
   * Accessible name for a column whose visible `label` is intentionally empty —
   * a row-actions or icon column. v1's `GridTableColumn` has carried this since
   * ISS-4672; v2 dropped it, so a blank-label column announced every cell
   * beneath it under an unnamed header until this field reached the element.
   *
   * It names the `columnheader` itself, and it is also what the column's own
   * controls (the sort button, the options button, the resize handle) call the
   * column, since none can spell a name out of a blank label. A column WITH a
   * visible label ignores it for the header cell — the visible text is already
   * that element's accessible name, and overriding it would contradict what the
   * user reads.
   */
  ariaLabel?: string;
  /**
   * Which end of the track this column's content sits at (ISS-9313).
   *
   * RESOLVED, not declared: a column registry emits its column's own `align` or
   * its kind's default through `resolveColumnAlignment`, so `Number` columns
   * arrive here already right-aligned. Absent — every consumer that builds this
   * array by hand — renders exactly as before, because `Start` is what the
   * header label and the data cell already do.
   *
   * **What it moves depends on {@link GridTableV2Props.alignValuesToColumn}
   * (ISS-9821).** It has always owned the HEADER and the data cell's own free
   * space. The cell primitive inside owns the VALUE, and `TableNumberCell`
   * right-aligns itself with `ml-auto` (`table-cell-primitives.tsx`), which
   * consumes the free space this column's `justify-end` would otherwise
   * distribute — so with that prop closed the track's justification is inert
   * over a canonical Number cell, and `align: Start` still yields a
   * start-aligned HEADER over a right-aligned VALUE. With it open the grid
   * publishes this alignment to the primitive, which takes it as its DEFAULT:
   * a cell passing `alignEnd` explicitly still wins.
   *
   * ABSENT IS NOT "THE AUTHOR STATED NOTHING". `toGridColumn` sets this field
   * unconditionally from `resolveColumnAlignment`, so a registry-built column
   * always carries an alignment — its own, or its kind's — and publishes it. An
   * absent value means a column array built BY HAND, which is what every
   * production v2 host still does; there the primitives keep their own default.
   */
  align?: ColumnAlignment;
};

/**
 * A contiguous section of rows rendered under a collapsible `GroupSectionHeader`
 * inside a single table (one column header shared across all groups).
 */
export type GridTableV2Group<T> = {
  key: string;
  label: string;
  items: T[];
  /**
   * The band's canonical, machine-readable value — what a host would WRITE to
   * move a row here, as opposed to `label`, which is what the band RENDERS
   * (ISS-8296).
   *
   * PRESENT-AND-EMPTY is meaningful and is NOT the same as absent: a band for
   * "explicitly unassigned" carries `""`. Test `!== undefined`, never
   * truthiness, or an intentional clear reads as an unmappable band.
   *
   * Absent means the band has no single canonical value — nothing was derived,
   * or its rows disagreed.
   */
  value?: string;
  /**
   * `false` refuses drops on this band: it is not a drop target and the drag
   * shows as such.
   *
   * Omitted keeps the previous behavior, where every band accepts, so a host
   * that does not set it is unchanged.
   */
  droppable?: boolean;
  /** Optional value-specific icon, such as an assignee avatar. */
  icon?: ReactNode;
  /** Optional second grouping level rendered as nested list sections. */
  subgroups?: GridTableV2Group<T>[];
  /**
   * The population this band describes, when its own `items` cannot say
   * (ISS-4704). A PAGED host holds one page of a band, so `items.length` there
   * is "on this page" wearing the population's clothes.
   *
   * THREE STATES, and the third is the point. Absent: the band's rows ARE the
   * population, so the count derives from them — every existing caller,
   * unchanged. A number: that number. `null`: the host knows it cannot state
   * one and NO number renders, which is what keeps a paged host from falling
   * back to the page-local length for the one band its totals do not cover.
   *
   * `showGroupCounts={false}` still suppresses the number in all three.
   */
  count?: number | null;
  /**
   * This band's rows began on an earlier page. Without it a band too large for
   * one page renders the same header twice and reads as two bands sharing a
   * name.
   */
  isContinued?: boolean;
};

export type GridTableV2Props<T> = {
  /**
   * Render a non-navigable ARIA table for read-only, link-driven consumers.
   * Omitted preserves the grid's roving cell focus and keyboard navigation.
   */
  staticTableSemantics?: boolean;
  /** Keeps the measured frame mounted when a host changes auto to compact. */
  preserveMeasuredContainer?: boolean;
  items: T[];
  getRowId: (item: T) => string;
  /** Columns after the leading (wide) column. */
  columns: readonly GridTableV2Column[];
  /** CSS grid template: lead column + one track per column + trailing slot. */
  gridTemplateColumns: string;
  leadingLabel: string;
  /** Optional hover guidance for the fixed leading column. */
  leadingTooltip?: string;
  /** Current width of the fixed leading identity column. */
  leadingColumnWidth?: number;
  /** Enables pointer and keyboard resize for the fixed leading column. */
  onLeadingColumnWidthChange?: (widthPx: number) => void;
  /** Content of the leading identity cell — typically a name link + id. */
  renderLead: (item: T, context: GridTableV2LeadContext) => ReactNode;
  /** Optional fixed utility cell rendered before the leading identity cell. */
  renderLeadingUtility?: (
    item: T,
    context: GridTableV2LeadContext
  ) => ReactNode;
  /** Keeps the utility inside the one-column narrow lead without adding a wide track. */
  renderLeadingUtilityInWide?: boolean;
  /** Row action placed after the lead and utility in the one-column narrow list. */
  renderNarrowTrailingAction?: (item: T) => ReactNode;
  /** Header content for `renderLeadingUtility`. */
  leadingUtilityHeader?: ReactNode;
  /**
   * Accessible name for the utility column, used when `leadingUtilityHeader`
   * renders nothing a screen reader can announce — which is the usual case,
   * because the column's header is visually empty.
   *
   * The utility column occupies a real grid track, so it needs a real
   * `columnheader`: without one the header row is a track SHORT of the body
   * rows, every remaining header pairs with the body cell of the column before
   * it, and the utility cell itself gets announced under the identity column's
   * name. Naming it is what keeps the two `aria-colindex` runs aligned, so this
   * has a default rather than being optional in practice — an unnamed column is
   * never the correct rendering.
   */
  leadingUtilityLabel?: string;
  /** Marks selected rows for the shared selected-row treatment. */
  isRowSelected?: (item: T) => boolean;
  /** Accessible selection name for the optional direct card projection. */
  getCardSelectionLabel?: (item: T, selected: boolean) => string;
  /** Row-level selection/activation. Interactive cell controls are ignored. */
  onRowClick?: (
    item: T,
    event: MouseEvent<HTMLDivElement>,
    renderedItems: readonly T[]
  ) => void;
  /**
   * Called when arrow-key navigation lands on a row, so hosts can keep focus
   * and selection in sync — including Shift+Arrow ranges.
   *
   * A host resolving a range must slice `renderedItems`, not the list it passed
   * in: with `groups` supplied, grouping reorders rows and the collapsed set is
   * this component's own state, so its list still holds rows the user never
   * traversed and cannot see. Additive — a two-parameter handler still assigns.
   */
  onRowKeyboardNavigate?: (
    item: T,
    event: KeyboardEvent<HTMLDivElement>,
    renderedItems: readonly T[]
  ) => void;
  /**
   * `Space` on a focused cell flips that row's selection (ISS-8067). Wire it
   * with the same toggle semantics the host gives a Ctrl/Cmd-click, or the two
   * input paths disagree about what "toggle one" means.
   */
  onRowSelectionToggle?: (item: T) => void;
  /**
   * `Ctrl/Cmd+A` selects every row the grid LISTS, which is what the table can
   * hand over that the host cannot re-derive: the host's own filtered list
   * minus anything inside a collapsed group. Passing those rows back beats
   * asking the host to recompute them and drift.
   *
   * The LISTED rows, not the painted ones — {@link virtualizeRows} makes those
   * two different sets, and a select-all over whatever a scroller happens to
   * show is not a select-all.
   */
  onSelectAllRows?: (items: readonly T[]) => void;
  /**
   * Reports the rows the grid paints after group-band and parent-row collapse,
   * so a host can drop hidden rows from its selection (ISS-12640).
   */
  onRenderedItemsChange?: (renderedItems: readonly T[]) => void;
  /** Content of a data cell. Return `null` for an intentionally empty cell. */
  renderCell: (columnId: string, item: T) => ReactNode;
  /** Sort state — wire all three to enable clickable column-header sorting. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /** Sort key for the leading column; clicking the lead header sorts by it. */
  leadingSortKey?: string;
  /**
   * Render each group header's row count. Pass `false` when `items` is only a
   * PAGE of a larger set — see `GroupSectionHeader.count`, where a bare number
   * beside the label reads as the population rather than "on this page".
   */
  showGroupCounts?: boolean;
  /**
   * When provided, the body renders one collapsible `GroupSectionHeader` per
   * group followed by that group's rows — a single table, not separate tables.
   * `items` is ignored in this mode.
   */
  groups?: GridTableV2Group<T>[];
  /** Icon shown in each group section header (the grouping dimension's icon). */
  groupIcon?: ReactNode;
  /** Enables row drag and reports the primary + optional secondary destination. */
  onGroupDrop?: (
    item: T,
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>,
    placement?: "start" | "end"
  ) => void;
  /** Restrict native drag to a descendant marked data-grid-row-drag-handle. */
  rowDragHandleOnly?: boolean;
  /** Opts a native row drag into the shared grip-and-title preview. */
  rowDragPreviewLabel?: (item: T) => string;
  onRowDrop?: (item: T, target: T, placement: "before" | "inside" | "after") => void;
  canDropOnRow?: (item: T, target: T, placement: "before" | "inside" | "after") => boolean;
  /** Narrows native group drag per row; absent preserves all-row drag. */
  canDragRow?: (item: T) => boolean;
  /** Refuses a specific row/destination pair before the band accepts it. */
  canDropOnGroup?: (
    item: T,
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => boolean;
  /** Optional legacy card projection for direct grid consumers. */
  cardRender?: (item: T, columns: readonly GridTableV2Column[]) => ReactNode;
  /**
   * Layout mode. With `cardRender`, the existing card fallback takes precedence.
   * Otherwise `auto` (default) follows the viewport width;
   * `expanded` renders every configured column; `compact` projects the same
   * grid to its one-column narrow list at any width.
   */
  mode?: GridTableV2Mode;
  /** Pin the fixed leading identity column during horizontal scroll. */
  pinLeadColumn?: boolean;
  /**
   * Whole-column fold fitting (ISS-4889). The table widens its IDENTITY track so
   * the container's right edge — the fold a horizontally-scrolling table is cut
   * at — lands on a column boundary instead of through the middle of a track, so
   * no column is rendered partially visible at rest. Nothing is hidden or
   * reordered; the columns past the fold are one scroll away at their declared
   * widths. Opt-in, and a no-op for a table that fits its container, so every
   * existing caller is byte-unchanged.
   *
   * The track that absorbs the leftover is the identity column, which is track 1
   * when {@link renderLeadingUtility} declares a utility track ahead of it and
   * track 0 otherwise. Absorbing into the utility track would grow the favourite
   * star rather than the name.
   *
   * ONE caveat, and it is the reason `GridTable` (v1) documents only ever
   * growing a track no user can resize: a surface that ALSO passes
   * {@link leadingColumnWidth} + {@link onLeadingColumnWidthChange} makes the
   * identity track resizable, and the resize handle bases its drag on the
   * declared width rather than the rendered one — so the rendered lead is wider
   * than the handle's base by the absorbed leftover, and a drag re-bases from
   * the declared width. The fitted width is never written back, so the user's
   * own persisted width is not corrupted by the fit.
   */
  snapFoldToColumns?: boolean;
  /**
   * How long (ms) the container width must hold still before
   * {@link snapFoldToColumns} re-fits the template (ISS-4906). `0` (default)
   * re-fits on every measurement, which is the behavior ISS-4889 shipped.
   *
   * The fit widens the identity track by the container's leftover, and that
   * leftover is bounded by the width of the first non-fitting track — so the
   * identity column ranges over that track's width and RESETS the instant the
   * next column starts to fit. During a continuous resize drag that reads as a
   * sawtooth: every column after the identity track jumps sideways at each fit
   * threshold.
   *
   * The discontinuity is structural, not a bug in the fit — "the fold lands on a
   * column boundary" and "the columns never move as the window moves" cannot
   * both hold, because the boundary the fold must land on changes at each
   * threshold. So this damps it in TIME rather than trying to remove it:
   * settling the measured width holds the last fitted template through the whole
   * drag and re-fits ONCE when the drag stops. The ISS-4889 guarantee is stated
   * at rest, and a drag in progress is not rest.
   *
   * Ignored unless {@link snapFoldToColumns} is set.
   */
  foldFitSettleMs?: number;
  /**
   * Column-reorder (FEA-4021). `columnOrder` is the current order of the DATA
   * column ids (the leading column is fixed and never reorders); pass it with
   * `onColumnOrderChange` to get drag-to-reorder + keyboard-reorder handles on
   * each data-column header. The table reorders its own `columns` by this order
   * before rendering; the CALLER must supply `gridTemplateColumns` tracks in the
   * SAME order (typically by ordering its own width-carrying specs with the
   * shared `orderColumns` helper) so a column and its track stay paired. Absent
   * → static headers, byte-identical to before.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * Column-width resize (FEA-4168). `columnWidths` is the current RENDERED pixel
   * width of each DATA column keyed by id — the base a drag/keyboard resize
   * adjusts from (typically the caller's per-column widths after applying its
   * persisted overrides via `applyColumnWidths`). Pass it with
   * `onColumnWidthChange` to grow a right-edge resize handle on each data-column
   * header (pointer drag AND keyboard `ArrowLeft`/`ArrowRight`); the handle
   * reports the new width (already clamped to the shared floor) and the CALLER
   * must fold that width back into its `gridTemplateColumns` track for the same
   * column so the header and body stay paired — exactly like `columnOrder`.
   * Absent → no resize handle, byte-identical to before.
   */
  columnWidths?: Readonly<Record<string, number>>;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  /**
   * Which of the ordered columns the user may MOVE (ISS-9313). A column left
   * out still holds its slot in `columnOrder` and still renders — it just grows
   * no drag affordance — which is what lets a host declare a fixed identity or
   * actions column without taking it out of the order the rest reorder within.
   *
   * Absent, every ordered column moves: unchanged for every caller that has not
   * declared per-column movability.
   */
  movableColumnIds?: readonly string[];
  /**
   * Which columns the user may RESIZE (ISS-9313). Absent, the resizable set is
   * whatever the caller seeded into `columnWidths`, which is what every v2
   * consumer relies on today. Supplying it separates the two facts that map
   * conflates: a column can carry a measured width without being the user's to
   * drag.
   */
  resizableColumnIds?: readonly string[];
  /** Optional column action menus for sorting, filtering, grouping, and discovery. */
  headerActions?: TableGridHeaderV2Actions;
  /**
   * Optional fixed trailing header control, such as an Add field button.
   *
   * Pass a FUNCTION to opt that control into the roving model when
   * {@link GridTableV2Props.navigableHeaderCells} is open (whitlockk review). The
   * slot is caller-owned markup, so the grid cannot make it a navigable cell on
   * the caller's behalf — it can only hand over the cell wiring, which is what
   * the argument is. Spread it onto the element you already give
   * `role="columnheader"` and its `aria-colindex`, and the arrows reach the
   * trailing control and `suppressCellTabStops` reaches the control inside it,
   * so the grid is ONE tab stop rather than two.
   *
   * The argument is `undefined` while the gate is closed, and spreading
   * `undefined` is a no-op, so one function serves both states. A plain
   * `ReactNode` still assigns and still renders exactly as before — it simply
   * keeps its own tab stop, which is the pre-ISS-8930 behaviour.
   */
  trailingHeader?: ReactNode | ((cellProps?: GridChromeCellProps) => ReactNode);
  /**
   * Paint only the rows the scroller can show, plus an overscan band
   * (ISS-12288). A 500-row page then commits a few dozen rows per render
   * instead of 500, which is what a poll or a focus refetch re-renders.
   *
   * The rows outside the window are stood in for by two spacers of their exact
   * height, so the scrollbar, the scroll offset and every row's position are
   * what they were, and `items`, select-all, range drag and
   * `onRowKeyboardNavigate` still speak about the WHOLE population.
   *
   * It DOES cost browser find-in-page and Ctrl/Cmd+A text selection over the
   * rows that are not painted: a row the window has scrolled past is not in the
   * document to be found, so Cmd+F reports no match for a session that is in
   * the list. Operator ruling 2026-10-12 (ISS-12288) accepted that for the
   * Sessions list, whose own search and filters are the supported way to find a
   * row by name. That ruling is scoped to Sessions — another surface taking
   * this opt-in is a fresh instance of the same trade, not a settled one.
   *
   * It is IGNORED, and every row paints as before, wherever the window could
   * not be computed honestly rather than guessed:
   * - `groups` is supplied. A band's header and its `renderAfterGroup` row are
   *   not one data row tall, and the bands are separate `rowgroup` elements, so
   *   one flat row index does not describe the body.
   * - {@link renderAfterItem} is supplied. A per-item slot renders a row of
   *   caller-owned height between two data rows, and the window's arithmetic is
   *   row index times a constant.
   * - The grid has no scrolling ancestor, or that ancestor reports no height
   *   (SSR, `display:none`, a detached container).
   *
   * Row lineage composes: {@link getChildren}'s expanded descendants are
   * ordinary `h-11` rows of the flattened list, so they are windowed with it.
   */
  virtualizeRows?: boolean;
  /** Optional row rendered after the ungrouped item collection. */
  renderAfterRows?: ReactNode;
  /** Optional row rendered directly after a specific item. */
  renderAfterItem?: (item: T) => ReactNode;
  /** Optional row rendered after each expanded group's item collection. */
  renderAfterGroup?: (group: GridTableV2Group<T>) => ReactNode;
  /**
   * Complete the APG grid pattern's single tab stop (ISS-8726): take the
   * controls INSIDE the cells out of the tab order, so `Tab` enters the grid
   * once instead of walking every favourite button, identity link and data-cell
   * control in turn. The roving tabindex already did the CELL half.
   *
   * The route in is the cell-entry model this grid already carries — `Enter` or
   * `F2` to enter a cell's content, `Escape` or `F2` to come back out — and a
   * cell whose content holds focus gets its own tab stops back for as long as
   * the user is inside it, so a cell holding several controls keeps all of them
   * reachable. Programmatic `focus()` is unaffected either way.
   *
   * Default false: this changes what a keyboard user's second `Tab` reaches, so
   * it ships closed and the caller opens it behind its own flag.
   */
  suppressCellTabStops?: boolean;
  /**
   * Bring the column-header row and the group-section headers into the roving
   * focus and cell-entry model the data cells already use (ISS-8930).
   *
   * ON: each `columnheader` and each group header cell carries `data-grid-cell`
   * and the shared roving `tabIndex`, and their rows join the arrow-key walk —
   * `ArrowUp` from the first data row reaches the group header and then the
   * column headers, `ArrowDown` comes back — with `Enter`/`F2` entering a cell
   * to operate the sort control, the resize handle or the collapse toggle
   * inside it. This is what lets {@link suppressCellTabStops} reach those
   * controls WITHOUT stranding them: a suppressed control in a cell that cannot
   * take focus would have no keyboard route at all, which is why ISS-8726 left
   * the header alone and the grid kept three tab stops rather than one.
   *
   * OFF (the default): byte-identical to before. The header row carries no
   * `data-grid-row`, its cells no `data-grid-cell`, and every control inside
   * them keeps its own native tab stop.
   *
   * Default false: it changes what the arrow keys do for every v2 consumer, so
   * it ships closed and the caller opens it behind its own flag.
   */
  navigableHeaderCells?: boolean;
  /**
   * Let {@link GridTableV2Column.align} reach the VALUE and not only the header
   * (ISS-9821).
   *
   * A grid renders through one table-level `renderCell`, so the node holding a
   * value is the host's and its props are out of this component's reach. Open,
   * each data cell publishes its column's alignment to the primitive inside,
   * which takes it as a DEFAULT — an explicit `alignEnd` on the cell still
   * wins, and a column carrying no `align` at all leaves every primitive on its
   * own. Closed — the default, and every consumer that has not opted in — the
   * value keeps whatever alignment its primitive chose, which for
   * `TableNumberCell` is the trailing edge regardless of the column.
   *
   * A REGISTRY-BUILT COLUMN ALWAYS CARRIES ONE, so opening this makes a kind
   * default authoritative for the value as well as the header. Only a hand-built
   * array leaves the field absent, and only there is the primitive left alone.
   *
   * Default false, because it changes rendered layout for any Number column
   * that carries a leading alignment.
   */
  alignValuesToColumn?: boolean;
  /**
   * Click-and-drag row range selection (ISS-8747), the pointer twin of
   * `Shift`+`Up`/`Down`. Press a row and drag over others to select the
   * contiguous range between them.
   *
   * Wide and narrow layouts share these rows, so the pointer interaction stays
   * available across a responsive flip. Touch remains excluded by the gesture
   * hook because a finger drag belongs to scrolling.
   *
   * Requires {@link onRowRangeDrag}; without it there is nowhere to report a
   * range and the drag is inert. Default false, because it changes what a press
   * on a row does.
   */
  enableRowRangeDrag?: boolean;
  /**
   * Where a range drag reports the rows it crosses. Called with the PRESS row
   * carrying no modifiers the moment a press becomes a drag, then with each row
   * the pointer reaches carrying `shiftKey`.
   *
   * The host resolves both through `resolveGridRowSelection`, exactly as it
   * resolves a click and a `Shift`-click, so the pointer and keyboard paths
   * cannot answer "what is a range" differently — this grid holds no selection
   * state of its own and decides nothing here.
   */
  onRowRangeDrag?: (
    item: T,
    modifiers: GridSelectionModifiers,
    renderedItems: readonly T[]
  ) => void;
  /**
   * Parent/child row lineage (ISS-8921). Return a row's child rows to make the
   * table a `treegrid`: each returned child paints as a row of the SAME table,
   * indented one level, under a disclosure control on its parent.
   *
   * THE SWITCH IS THIS PROP'S PRESENCE, and nothing else. Absent — which is
   * every consumer that has not opted in — the table renders `role="grid"` with
   * no `aria-level`, no `aria-posinset`, no `aria-setsize`, no `aria-expanded`,
   * no disclosure control and no indent, and `ArrowLeft`/`ArrowRight` keep their
   * plain column meaning. Nesting is additive and inert, not a mode with a
   * default.
   *
   * Deliberately an ACCESSOR, not a `children` field on the row type: the table
   * stays data-agnostic, so a caller's own record shape (whatever names its
   * lineage) needs no adapter type to be nestable.
   *
   * Row ids must be unique across the WHOLE tree, not just among siblings —
   * they key the roving tab stop and the expansion state. A repeated id is
   * painted once, at its first position, rather than recursing forever.
   */
  getChildren?: (item: T) => readonly T[] | undefined;
  /**
   * Where the roving tab stop should land when the grid has no remembered cell
   * of its own (ISS-9555) — a caller that wants the reader's keyboard resumed
   * on a particular row after the grid was unmounted and rebuilt.
   *
   * THE THIRD CHOICE, NOT THE FIRST. The roving stop resolves in this order:
   * the cell the reader last focused, IF this render still paints it; then this
   * key, IF this render paints it; then the grid's own entry cell. So a caller
   * can never move the tab stop out from under a reader who is already in the
   * grid, and the staleness guard still governs — a key naming a row that is
   * not on this page falls through to the entry cell exactly as a stale
   * remembered key does.
   *
   * A live VALUE, not a seed: it is re-read every render, so a caller may stop
   * offering it (pass `undefined`) once it has been resumed, and the grid holds
   * no copy that could outlive the offer.
   *
   * Absent — which is every consumer that has not opted in — the resolution is
   * byte-identical to before: remembered-if-rendered, else entry cell. Build
   * the key with `buildCellKey(rowId, columnKey)` from
   * `@closedloop-ai/design-system/lib/grid-table-v2-rows`; a string this grid never
   * emits is simply never matched.
   *
   * Wide and narrow layouts share the same gridcell and roving-tabindex model,
   * so the key remains meaningful across a responsive layout flip when its
   * column is still rendered. A hidden data-column key falls back to the narrow
   * list's entry cell until wide mode returns.
   */
  preferredActiveCellKey?: string;
  /**
   * Row ids open on first render. Uncontrolled: the table owns expansion from
   * then on. Ignored without `getChildren`, because nothing can be expanded.
   */
  defaultExpandedRowIds?: readonly string[];
  /** Notified after a row is expanded or collapsed, for a host that persists it. */
  onRowExpandedChange?: (item: T, expanded: boolean) => void;
  /** Accessible name of a closed row's disclosure control. */
  expandRowLabel?: string;
  /** Accessible name of an open row's disclosure control. */
  collapseRowLabel?: string;
  /**
   * Host-owned band collapse (ISS-9335). Present, the grid ASKS rather than
   * remembers: it reads `isCollapsed` every render and reports every change
   * through `setCollapsed`, holding no copy that could disagree with the host's.
   *
   * That is what a host with collapse state of its own needs — one persisted
   * across mounts, carried in a URL, or shared by a second view of the same
   * bands. A seed-once prop cannot express it: the grid would keep answering
   * from the snapshot it took at mount.
   *
   * A SUBGROUP's key is the composed `buildSubgroupKey(groupKey, subgroupKey)`
   * from `@closedloop-ai/design-system/lib/grid-table-v2-rows`, not its bare `key` —
   * two subgroups of different parents may share a bare key.
   *
   * Absent — every consumer that has not opted in — the grid owns collapse in
   * its own state, byte-identical to before.
   */
  groupCollapse?: {
    isCollapsed: (groupKey: string) => boolean;
    setCollapsed: (groupKey: string, collapsed: boolean) => void;
  };
  /**
   * Host-owned row expansion (ISS-9335), the lineage twin of
   * {@link GridTableV2Props.groupCollapse}. Present, {@link
   * GridTableV2Props.defaultExpandedRowIds} is ignored — a seed and a live
   * answer are two sources for one fact — while `onRowExpandedChange` still
   * fires for hosts that listen.
   *
   * The capability it buys over the seed is expansion the host changes AFTER
   * mount: a filter that must reveal a matching descendant has to force its
   * ancestors open while the user types, and a once-only seed cannot.
   *
   * The host owns the bound the internal set gets from `nextExpandedRowIds`;
   * the grid cannot prune a set it does not hold. Ignored without
   * `getChildren`, because nothing can be expanded.
   */
  rowExpansion?: {
    isExpanded: (rowId: string) => boolean;
    setExpanded: (rowId: string, expanded: boolean) => void;
  };
  /**
   * Select-all, rendered as a tri-state checkbox INSIDE the leading identity
   * header cell (ISS-9335) — the same place `TableGridHeader` has put it since
   * ISS-4672, and the reason this costs no layout: it sits beside the lead
   * label, mirroring a row checkbox that sits beside the row's own identity.
   * It claims no grid track, so no column is added, moved or resized.
   *
   * Every field here was already on `TableGridHeaderV2`; what was missing was
   * this compositor passing them down, so a v2 table could not offer select-all
   * at all. `onSelectAllRows` is the KEYBOARD twin, not a substitute: that one
   * reports `Ctrl/Cmd+A` over the rows the grid painted, this one is the
   * visible control, and a host with bulk actions needs both.
   *
   * Absent — every consumer that has not opted in — renders no checkbox, and
   * the lead header cell is byte-identical to before.
   */
  showSelectAll?: boolean;
  /** Checked state of {@link GridTableV2Props.showSelectAll}. */
  allSelected?: boolean;
  /** Indeterminate state of {@link GridTableV2Props.showSelectAll}. */
  someSelected?: boolean;
  /** Where the select-all checkbox reports a change. */
  onSelectAll?: (checked: boolean) => void;
  /**
   * Sort the LEAD column by one of several keys (ISS-9335), as a dropdown on
   * the lead label instead of {@link GridTableV2Props.leadingSortKey}'s single
   * toggle. Supply one or the other, never both — with options present the key
   * is ignored, and `aria-sort` is derived from whichever option is active.
   *
   * Each item cycles asc → desc → clear, so
   * {@link GridTableV2Props.onClearSort} is not a separate affordance: it is
   * the third press of the same item, and without it the cycle simply stops at
   * descending.
   */
  leadingSortOptions?: readonly TableGridHeaderV2SortOption[];
  /** Where the third press of a `leadingSortOptions` item reports. */
  onClearSort?: () => void;
};

/**
 * The row-selection half of {@link GridTableV2Props}, as one value a list
 * produces once and its grid spreads, instead of each list threading every
 * selection callback through its own layers.
 */
export type GridTableV2SelectionProps<T> = Pick<
  GridTableV2Props<T>,
  | "allSelected"
  | "enableRowRangeDrag"
  | "getCardSelectionLabel"
  | "isRowSelected"
  | "onSelectAll"
  | "onRowClick"
  | "onRowKeyboardNavigate"
  | "onRowRangeDrag"
  | "onRowSelectionToggle"
  | "onRenderedItemsChange"
  | "onSelectAllRows"
  | "showSelectAll"
  | "someSelected"
>;

/** Responsive facts available to the caller-owned identity-cell renderer. */
export type GridTableV2LeadContext = {
  isNarrowList: boolean;
};
