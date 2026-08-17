"use client";

import { useContainerWidth } from "@closedloop-ai/design-system/hooks/use-container-width";
import { useSettledValue } from "@closedloop-ai/design-system/hooks/use-settled-value";
import { fitGridTemplateToWholeColumns } from "@closedloop-ai/design-system/lib/column-fold";
import {
  CARD_FALLBACK_BREAKPOINT,
  MIN_COLUMN_WIDTH_PX,
  orderColumns,
} from "@closedloop-ai/design-system/lib/column-order";
import {
  FIRST_COLUMN_INDEX,
  getColumnCount,
  getDataColumnIndex,
} from "@closedloop-ai/design-system/lib/grid-table-aria";
import {
  focusCellFromRowClick,
  GRID_NAV_CELL_ROLE,
  GRID_NAV_TABLE_ROLE,
  isInteractiveRowClickTarget,
  resolveNextGridCell,
  shouldSkipGridNavigation,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useState,
} from "react";
import { GroupSectionHeader } from "./group-section-header";
import type { SortDirection } from "./sortable-column-header";
import type { TableGridHeaderActions } from "./table-grid-column-menu";
import {
  TableGridHeader,
  type TableGridHeaderAlign,
} from "./table-grid-header";

/**
 * Generic grid table built on the shared `TableGridHeader` + a `grid min-w-fit`
 * row. Data-agnostic: callers supply the row type, column descriptors, the CSS
 * grid template, and render functions for the leading cell and each data cell.
 * Shared across surfaces (web `apps/app`, desktop renderer) so tables stay
 * structurally identical.
 *
 * The component renders no `overflow` wrapper — the host owns the scroll
 * container, so the sticky header and horizontal scroll resolve against it. Each
 * row + the header are `min-w-fit`, so the container scrolls horizontally when
 * columns exceed the viewport.
 *
 * Sorting is opt-in: pass `onSort` (+ `sortBy`/`sortDir`) and mark sortable
 * columns with `sortable: true` to get clickable headers with sort indicators
 * (the leading cell sorts via `leadingSortKey`). Without `onSort`, headers
 * render as plain labels. Set a column's `className` to `"opacity-50"` to flag
 * it as a placeholder.
 *
 * Column reorder is opt-in (FEA-4021): pass `columnOrder` + `onColumnOrderChange`
 * and each data-column header grows a drag handle (pointer drag-and-drop AND
 * keyboard `ArrowLeft`/`ArrowRight`); the table reorders its own columns by
 * `columnOrder` and the caller keeps its `gridTemplateColumns` tracks in the
 * same order (via the `orderColumns` helper). Column show/hide is a companion
 * generic `TableViewMenu` (its "Show / Hide Columns" section) a caller places in
 * its toolbar; dropping a hidden column's grid track stays with the caller
 * because a `gridTemplateColumns` string cannot be sliced generically.
 *
 * Responsive card fallback (FEA-3865): pass `cardRender` to get a stacked card
 * list on narrow surfaces instead of a horizontally-scrolling grid. The table
 * measures its own container width (not the viewport) and renders exactly one
 * layout — below the `md` breakpoint (768px) the card list, at `md+` the CSS
 * grid. `mode` forces one path: `auto` (default) follows the measured width,
 * `expanded` always renders the grid, `compact` always renders cards. A caller
 * that opts into NEITHER this nor `snapFoldToColumns` below is byte-unchanged:
 * the grid renders with no container wrapper, so desktop and the existing
 * mini-tables look exactly as before. SSR — and a container that measures zero —
 * renders the grid, so the desktop default never flashes a card list.
 *
 * Whole-column fold fitting (ISS-4889): pass `snapFoldToColumns` and the
 * table widens its leading track so the container's right edge — the fold a
 * horizontally-scrolling table is cut at — lands on a column boundary instead of
 * through the middle of a track, so no column is rendered partially visible at
 * rest. Nothing is hidden or reordered; the columns past the fold are one scroll
 * away at their declared widths. Opt-in, and a no-op for a table that fits its
 * container, so every existing caller is byte-unchanged. Pair it with
 * `foldFitSettleMs` (ISS-4906) to hold the fitted template still through a
 * continuous resize instead of re-fitting — and stepping the columns sideways —
 * at every threshold the drag crosses.
 *
 * ARIA table semantics (ISS-4672): the grid is `div`s laid out with CSS `grid`,
 * so none of the row/column relationships a native `<table>` gives for free
 * exist implicitly — they are declared. The grid wrapper is `role="table"` with
 * `aria-colcount`; the header row and every body row are `role="row"`; header
 * cells are `role="columnheader"` and body cells `role="cell"`; and BOTH carry
 * the `aria-colindex` of their grid track, which is what makes a screen reader
 * announce a cell as "Status, Active" rather than a loose "Active". Grouped
 * mode wraps each group in a `role="rowgroup"` whose first row is the
 * collapsible section header spanning every column (`aria-colspan`), so the
 * group label stays inside the table's reading order instead of interrupting
 * it. WCAG 1.3.1 (Info and Relationships). The card fallback is a different
 * reading order entirely and deliberately carries no table roles.
 */

export type GridTableMode = "auto" | "compact" | "expanded";

export type GridTableColumn = {
  id: string;
  label: string;
  /**
   * Extra classes for this column's body + header cells — NOT alignment. A
   * `justify-*` here is inert on a SORTABLE column yet appears to work on a
   * non-sortable one (ISS-5333). Use {@link GridTableColumn.headerAlign}.
   */
  className?: string;
  /**
   * ISS-5333: which end of its header cell this column's LABEL sits at, forwarded
   * to `TableGridHeader`. Opt-in: absent leaves the header exactly as it renders
   * today, so a right-aligned default can never silently reflow a table that did
   * not ask for one. Use this rather than a `justify-end` in `className` — on a
   * sortable column that class is inert (see `TableGridHeaderColumn.headerAlign`).
   */
  headerAlign?: TableGridHeaderAlign;
  /** When true (and `onSort` is provided), the header is a clickable sort control. */
  sortable?: boolean;
  /** Optional help text shown via an info icon + tooltip in the column header. */
  tooltip?: string;
  /**
   * Accessible name for a column whose visible `label` is intentionally empty —
   * a row-actions or other chrome column (ISS-4672). Such a column still owns a
   * grid track that every body cell's `aria-colindex` resolves against, so
   * without a name a screen reader announces those cells under a blank column.
   * Ignored when `label` has text: the visible label is already the name.
   */
  ariaLabel?: string;
  /**
   * Visible `dt` term for this column when it appears in a table→card body
   * (`buildGridTableCardFields`), for a column whose `label` is intentionally
   * empty. The narrow card has no header row to read a value against, so a
   * caller that genuinely wants a label-less column in the card body names it
   * here with a real, human-visible term. The accessible `ariaLabel` (e.g.
   * "Actions" for a kebab menu) is deliberately NOT borrowed as that term: it
   * names a grid track for assistive tech, not a value worth a visible label on
   * the narrow card (ISS-4672). Omitted ⇒ the card term stays blank.
   */
  cardLabel?: string;
  /**
   * GridTable v2 per-column menu opt-ins, forwarded to `TableGridHeader`. Each
   * only produces a menu item when the table ALSO wires the matching
   * `headerActions` callback, so a column can never advertise an action the
   * table cannot perform. All absent (the default) → no menu button renders.
   */
  filterable?: boolean;
  groupable?: boolean;
  movable?: boolean;
};

/**
 * A contiguous section of rows rendered under a collapsible `GroupSectionHeader`
 * inside a single table (one column header shared across all groups).
 */
export type GridTableGroup<T> = {
  key: string;
  label: string;
  items: T[];
};

type GridTableProps<T> = {
  items: T[];
  getRowId: (item: T) => string;
  /** Columns after the leading (wide) column. */
  columns: readonly GridTableColumn[];
  /** CSS grid template: lead column + one track per column + trailing slot. */
  gridTemplateColumns: string;
  leadingLabel: string;
  /** Content of the leading (wide) cell — typically a name link + id. */
  renderLead: (item: T) => ReactNode;
  /** Content of a data cell. Return `null` for an intentionally empty cell. */
  renderCell: (columnId: string, item: T) => ReactNode;
  /** Sort state — wire all three to enable clickable column-header sorting. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /** Sort key for the leading column; clicking the lead header sorts by it. */
  leadingSortKey?: string;
  /**
   * When provided, the body renders one collapsible `GroupSectionHeader` per
   * group followed by that group's rows — a single table, not separate tables.
   * `items` is ignored in this mode.
   */
  groups?: GridTableGroup<T>[];
  /** Icon shown in each group section header (the grouping dimension's icon). */
  groupIcon?: ReactNode;
  /**
   * Show each group's row count in its section header. Defaults to `true` (the
   * shipped behavior). Pass `false` when `items` is one page of a
   * server-paginated set: a bare number beside the band label reads as the whole
   * population when it only ever counts what is loaded.
   */
  showGroupCount?: boolean;
  /**
   * Responsive card renderer (FEA-3865). When provided, the table can fall back
   * to a stacked card list on narrow surfaces instead of a scrolling grid. It
   * receives the row and the table's `columns` so the card can lay the lead cell
   * out as a header and the data columns as a key/value body. Without it, the
   * table only ever renders the grid (unchanged behavior).
   */
  cardRender?: (item: T, columns: readonly GridTableColumn[]) => ReactNode;
  /**
   * Layout mode (FEA-3865). `auto` (default): follow the measured container
   * width — cards below the `md` breakpoint (768px), grid at `md+`. `expanded`:
   * always the grid. `compact`: always cards. `compact` and the card half of
   * `auto` only take effect when `cardRender` is supplied; otherwise the grid
   * always renders.
   */
  mode?: GridTableMode;
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
   * Whole-column fold fitting (ISS-4889). When true, the table measures its own
   * container and widens the LEADING track so the container's right edge — the
   * fold a horizontally-scrolling table is cut at — lands exactly on a column
   * boundary, instead of through the middle of a track. No column is hidden,
   * dropped, or reordered: everything past the fold is still there, at its
   * declared width, one scroll away. Absent → the template renders verbatim,
   * byte-identical to before.
   *
   * Opt in on a wide table whose columns routinely overflow their host (the
   * Sessions list is the first adopter), where a half-rendered chip — or a
   * currency figure clipped mid-glyph, per ISS-4788 — is the failure mode. It is
   * a no-op for a table that fits its container, and it degrades to no change
   * when the template declares a track with no px length (see
   * `fitGridTemplateToWholeColumns`).
   *
   * Scope of the guarantee: it holds AT REST, i.e. at `scrollLeft` 0, which is
   * the state a table is read in and the state the reported defect was seen in.
   * It is a track-width fit, not a scroll snap — once the user scrolls right,
   * tracks straddle the viewport's LEFT edge again, exactly as they would in any
   * horizontally-scrolling table. That is expected and deliberately not
   * corrected: pinning every scroll offset to a boundary would mean overriding
   * the user's own scroll position.
   *
   * Two things it assumes, neither of which any caller violates today:
   *  - the grid has NO column gap, so the tracks account for the whole width. A
   *    `gap-x-*` added through `TableGridHeader`'s `className` would move the
   *    real fold by `(trackCount - 1) x gap` with no failure signal.
   *  - the leading column is not resizable. `columnWidths` covers data columns
   *    only, so widening the lead can never contradict a persisted width; a
   *    caller that made the lead resizable would desync its handle's base from
   *    the rendered width.
   */
  snapFoldToColumns?: boolean;
  /**
   * How long (ms) the container width must hold still before `snapFoldToColumns`
   * re-fits the template (ISS-4906). `0` (default) re-fits on every measurement,
   * which is the behavior ISS-4889 shipped.
   *
   * The fit widens the leading track by the container's leftover, and that
   * leftover is bounded by the width of the first non-fitting track — so on a
   * table whose widest track around the fold is 180px, the lead ranges over
   * ~180px of width and RESETS the instant the next column starts to fit. During
   * a continuous resize drag that reads as a sawtooth: every column after the
   * lead jumps sideways at each fit threshold.
   *
   * The discontinuity is structural, not a bug in the fit — "the fold lands on a
   * column boundary" and "the columns never move as the window moves" cannot
   * both hold, because the boundary the fold must land on changes at each
   * threshold. So this damps it in TIME rather than trying to remove it:
   * settling the measured width holds the last fitted template through the whole
   * drag (columns perfectly still, the fold cutting through a track exactly as
   * an unfitted table's would) and re-fits ONCE when the drag stops. The
   * ISS-4889 guarantee is stated at rest, and a drag in progress is not rest.
   *
   * Deliberately NOT a CSS `transition` on `grid-template-columns`: the fitted
   * lead width is continuous in container width, so a transition would retrigger
   * every resize frame and make the smooth common case lag in order to soften a
   * rare jump. Deliberately not a cap on how much the lead may absorb either —
   * that reintroduces the half-cut column at exactly the widths where the cut is
   * largest, which is the defect ISS-4889 exists to remove.
   *
   * Ignored unless `snapFoldToColumns` is set.
   */
  foldFitSettleMs?: number;
  /**
   * GridTable v2 — row selection. Marks a row as selected so it carries the
   * shared selected treatment. Selection deliberately BEATS hover
   * (`hover:bg-primary/10` restates the selected background) so a selected row
   * does not flicker to the hover tint when the pointer crosses it.
   */
  isRowSelected?: (item: T) => boolean;
  /**
   * GridTable v2 — row activation. Fires for a click anywhere in the row EXCEPT
   * on a control that owns its own activation (a link, button, checkbox…), so
   * a row-level select never steals a cell's own click. The click also hands off
   * to the keyboard by focusing the cell that was clicked, so arrow navigation
   * continues from where the pointer left off.
   */
  onRowClick?: (item: T) => void;
  /**
   * GridTable v2 — arrow-key cell navigation. Opt-in, because it changes the
   * table's ARIA role: arrow-navigable cells make this a `grid` widget rather
   * than a static `table`, and every cell becomes a `gridcell` with a roving
   * tabindex. A table that leaves this off keeps the exact `table`/`cell`
   * semantics ISS-4672 shipped.
   */
  keyboardCellNavigation?: boolean;
  /**
   * GridTable v2 — a fixed utility cell rendered BEFORE the leading identity
   * cell (a row checkbox, a drag grip). The caller adds the matching first
   * track to `gridTemplateColumns`, exactly as it does for every other column.
   */
  renderLeadingUtility?: (item: T) => ReactNode;
  /** Header content paired with `renderLeadingUtility` (e.g. a select-all box). */
  leadingUtilityHeader?: ReactNode;
  /** GridTable v2 — per-column menu actions (filter / group / move). */
  headerActions?: TableGridHeaderActions;
  /**
   * GridTable v2 header presentation (ISS-4779 closed-by-default) — the
   * hover-revealed sort caret, the decoupled resize strip, and the drag
   * fade/insertion rule. Forwarded to `TableGridHeader`; absent → every table
   * that renders this header keeps its pre-v2 appearance. See
   * `TableGridHeaderProps.enhancedHeaderInteractions`.
   */
  enhancedHeaderInteractions?: boolean;
};

export function GridTable<T>({
  items,
  getRowId,
  columns,
  gridTemplateColumns,
  leadingLabel,
  renderLead,
  renderCell,
  sortBy,
  sortDir = "asc",
  onSort,
  leadingSortKey,
  groups,
  groupIcon = null,
  showGroupCount = true,
  cardRender,
  mode = "auto",
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  snapFoldToColumns = false,
  foldFitSettleMs = 0,
  isRowSelected,
  onRowClick,
  keyboardCellNavigation = false,
  renderLeadingUtility,
  leadingUtilityHeader,
  headerActions,
  enhancedHeaderInteractions = false,
}: GridTableProps<T>) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  // Roving tabindex (WAI-ARIA APG grid pattern): exactly ONE cell is in the tab
  // order at a time, and the arrow keys move both focus and that entry point.
  // The prototype made every cell `tabIndex={0}`, which on a 25-row × 14-column
  // table is 350 tab stops between the table and the next control — so this
  // keeps the prototype's behavior and drops its tab-order cost. `null` = the
  // grid has not been entered yet, and the first cell is the entry point.
  const [activeCellKey, setActiveCellKey] = useState<string | null>(null);

  // FEA-4021: reorder the data columns by the caller's persisted `columnOrder`
  // before rendering. The caller pairs `gridTemplateColumns` tracks to the same
  // order (see the props doc), so a column and its track stay aligned. Absent →
  // the input order is preserved unchanged.
  const orderedColumns = orderColumns(columns, columnOrder);
  // Reorder targets the RENDERED order. An empty (or absent) `columnOrder` is
  // the natural-order convention (`orderColumns` treats `[]` as natural), so
  // fall back to the rendered ids — otherwise `[]` would pass no id the header's
  // `columnOrder.includes` check and every drag handle would vanish, leaving a
  // controlled caller unable to start the first reorder.
  const fullColumnOrder =
    columnOrder && columnOrder.length > 0
      ? columnOrder
      : orderedColumns.map((column) => column.id);
  // FEA-4168: resize wiring for the header. `getColumnWidth` resolves a column's
  // current rendered px width from the caller's `columnWidths` map (the base a
  // drag/keyboard resize adjusts from); a column absent from the map (a caller
  // that has not measured it yet) degrades to the shared floor so a resize still
  // starts from a sane, grabbable width. The caller folds the emitted width back
  // into its `gridTemplateColumns`, mirroring the reorder contract.
  const resize =
    onColumnWidthChange != null
      ? {
          // Only columns the caller seeds into `columnWidths` are resizable, so
          // trailing chrome columns (actions/extra, absent from the map) never
          // get a lying resize handle — mirrors how reorder gates on columnOrder.
          columnIds: Object.keys(columnWidths ?? {}),
          getColumnWidth: (columnId: string) =>
            columnWidths?.[columnId] ?? MIN_COLUMN_WIDTH_PX,
          onResize: onColumnWidthChange,
        }
      : undefined;
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const {
    ref: containerRef,
    width: containerWidth,
    measured: isContainerMeasured,
  } = useContainerWidth<HTMLDivElement>();

  // ISS-4906: the width the fold fit is DERIVED from, held still through a
  // continuous resize so the fitted lead — and therefore every column after it —
  // stops stepping sideways at each fit threshold. A `foldFitSettleMs` of 0 (the
  // default) returns the measured width verbatim, so an un-opted-in caller fits
  // on every measurement exactly as before.
  const foldFitWidth = useSettledValue(containerWidth, foldFitSettleMs);

  // Exactly one layout renders (no duplicated DOM): the card fallback is only
  // reachable with a `cardRender`, and then `auto` picks by the measured
  // container width, `compact` forces cards, `expanded` forces the grid. A table
  // with no `cardRender` always renders the bare grid, byte-identical to before.
  const hasCardFallback = cardRender != null;
  const showCards =
    hasCardFallback &&
    (mode === "compact" ||
      (mode === "auto" && containerWidth < CARD_FALLBACK_BREAKPOINT));

  // ISS-4889: widen the leading track so the container's right edge lands on a
  // column boundary, leaving no track rendered partially visible at rest. Gated
  // on a REAL measurement (never the hook's wide pre-measure default), so the
  // first paint and SSR render the caller's template untouched and the fit is
  // applied once — rather than snapping to a guessed width and then correcting.
  const renderedGridTemplateColumns =
    snapFoldToColumns && isContainerMeasured
      ? fitGridTemplateToWholeColumns(gridTemplateColumns, foldFitWidth)
      : gridTemplateColumns;
  // The measured wrapper is what makes all of the above possible, so it renders
  // for any of the opt-ins. A table using none stays wrapper-free.
  const hasMeasuredContainer = hasCardFallback || snapFoldToColumns;

  // GridTable v2: arrow-key navigation makes this an ARIA `grid` widget rather
  // than a static `table`, and its cells `gridcell`s. Gated on the opt-in so a
  // table that does not wire navigation keeps the exact roles ISS-4672 shipped.
  const navigationEnabled = keyboardCellNavigation;
  const tableRole = navigationEnabled ? GRID_NAV_TABLE_ROLE : "table";
  const bodyCellRole = navigationEnabled ? GRID_NAV_CELL_ROLE : "cell";

  // A leading utility column (checkbox / grip) takes the FIRST track, pushing
  // the identity cell to the second. Deriving both indexes from one base keeps
  // the header's and body's `aria-colindex` numbering paired — they desync
  // silently if only one side accounts for the utility track.
  const leadingUtilityColumnIndex = renderLeadingUtility
    ? FIRST_COLUMN_INDEX
    : undefined;
  const leadColumnIndex = renderLeadingUtility
    ? FIRST_COLUMN_INDEX + 1
    : FIRST_COLUMN_INDEX;

  /**
   * Per-cell navigation attributes. Off → `{}`, so a non-navigable table emits
   * no extra DOM at all. On → the cell becomes focusable with a roving
   * tabindex: the active cell (or the first cell before the grid has been
   * entered) is the single tab stop.
   */
  const buildCellNavigationProps = (cellKey: string) => {
    if (!navigationEnabled) {
      return {};
    }
    const isActive = cellKey === effectiveActiveCellKey;
    return {
      "data-grid-cell": "",
      "data-grid-cell-key": cellKey,
      onFocus: () => setActiveCellKey(cellKey),
      onKeyDown: handleCellKeyDown,
      tabIndex: isActive ? 0 : -1,
    } as const;
  };

  const handleCellKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      shouldSkipGridNavigation(event.key, event.target, {
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      })
    ) {
      return;
    }
    const nextCell = resolveNextGridCell(event.currentTarget, event.key);
    if (!nextCell) {
      // At an edge: leave the key alone so it keeps its native meaning (e.g.
      // scrolling the page) rather than being silently swallowed.
      return;
    }
    // `preventDefault` stops the arrow key from ALSO scrolling the table's
    // scroll container, which would make the grid lurch on every keypress.
    event.preventDefault();
    nextCell.focus();
  };
  // Total grid tracks a row occupies: the leading cell plus one per data column.
  // Published on the table as `aria-colcount` and used as the group header row's
  // `aria-colspan`, so both stay derived from the rendered columns. `leadColumnIndex`
  // already absorbs the optional leading-utility track, so the count follows it.
  const columnCount = getColumnCount(leadColumnIndex, orderedColumns.length);

  // The rows the grid actually paints this render: in grouped mode a COLLAPSED
  // group renders none of its items, so it contributes no focusable cell.
  const renderedItems = groups
    ? groups.flatMap((group) =>
        collapsedGroups.has(group.key) ? [] : group.items
      )
    : items;

  // The grid's keyboard entry point before any cell has been focused: the lead
  // cell of the first row that is actually rendered.
  const firstRenderedItem = renderedItems[0];
  const firstCellKey =
    firstRenderedItem === undefined
      ? null
      : `${getRowId(firstRenderedItem)}::__lead__`;

  // wongk review: the roving tabindex must never point at a cell that is no
  // longer on screen. A data change (a page/filter change dropping the focused
  // row) or a group collapse leaves `activeCellKey` naming a row nothing renders
  // — and because every OTHER cell then compares unequal, the whole grid goes
  // `tabIndex={-1}` and drops out of the tab order entirely. Fall back to the
  // first rendered cell whenever the remembered key is not among the keys this
  // render will emit. Membership is computed against the rendered keys rather
  // than parsed out of the string, because a row id may itself contain `::`.
  const renderedCellKeys = navigationEnabled
    ? new Set(
        renderedItems.flatMap((item) => {
          const rowId = getRowId(item);
          return [
            `${rowId}::__lead__`,
            ...orderedColumns.map((column) => `${rowId}::${column.id}`),
          ];
        })
      )
    : null;
  const effectiveActiveCellKey =
    activeCellKey !== null && renderedCellKeys?.has(activeCellKey) === true
      ? activeCellKey
      : firstCellKey;

  const renderRow = (item: T): ReactNode => {
    const rowId = getRowId(item);
    const selected = isRowSelected?.(item) === true;
    // Criterion 4 — the click→keyboard handoff. The row's click focuses the
    // cell the pointer actually landed in, so the next arrow key continues from
    // there rather than from the top of the table. A click on a control that
    // owns its own activation (link, button, checkbox) is left alone entirely.
    const handleRowClick =
      onRowClick || navigationEnabled
        ? (event: ReactMouseEvent<HTMLDivElement>) => {
            if (!(event.target instanceof HTMLElement)) {
              return;
            }
            if (isInteractiveRowClickTarget(event.target)) {
              return;
            }
            if (navigationEnabled) {
              const cell = focusCellFromRowClick(event.target);
              const cellKey = cell?.dataset.gridCellKey;
              if (cellKey) {
                setActiveCellKey(cellKey);
              }
            }
            onRowClick?.(item);
          }
        : undefined;
    return (
      <div
        className={cn(
          "group grid h-11 min-w-fit items-center border-b bg-[var(--grid-table-surface,var(--background))]",
          // Criterion 3 — selection BEATS hover. Restating the selected tint in
          // the hover slot is deliberate: without it the row flips to the
          // neutral hover grey as the pointer crosses it, so a selected row
          // appears to deselect itself on mouseover.
          selected
            ? "bg-primary/10 hover:bg-primary/10"
            : "hover:bg-muted/40",
          handleRowClick && "cursor-pointer"
        )}
        data-grid-row=""
        data-state={selected ? "selected" : undefined}
        key={rowId}
        onClick={handleRowClick}
        role="row"
        style={{ gridTemplateColumns: renderedGridTemplateColumns }}
      >
        {renderLeadingUtility ? (
          <div
            aria-colindex={leadingUtilityColumnIndex}
            className="flex h-full min-w-0 items-center justify-center"
            role={bodyCellRole}
          >
            {renderLeadingUtility(item)}
          </div>
        ) : null}
        <div
          aria-colindex={leadColumnIndex}
          className={cn(
            "flex min-w-0 flex-col justify-center py-1 pr-3 pl-4",
            navigationEnabled &&
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          )}
          role={bodyCellRole}
          {...buildCellNavigationProps(`${rowId}::__lead__`)}
        >
          {renderLead(item)}
        </div>
        {/* No trailing border cell: columns are separated by `border-l`; the
            table's left and right edges are intentionally open. (A fixed-size
            phantom trailing cell here used to overlap the first row's lead cell
            when a caller's template lacked a track for it.) */}
        {orderedColumns.map((column, index) => (
          <GridTableCell
            cellRole={bodyCellRole}
            colIndex={getDataColumnIndex(leadColumnIndex, index)}
            columnId={column.id}
            key={column.id}
            {...buildCellNavigationProps(`${rowId}::${column.id}`)}
          >
            {renderCell(column.id, item)}
          </GridTableCell>
        ))}
      </div>
    );
  };

  const renderCardItem = (item: T): ReactNode => (
    <div key={getRowId(item)}>{cardRender?.(item, orderedColumns)}</div>
  );

  const cardList = (
    <div className="flex flex-col gap-3 p-3">
      {groups
        ? groups.map((group) => {
            const isOpen = !collapsedGroups.has(group.key);
            return (
              <div className="flex flex-col gap-3" key={group.key}>
                <GroupSectionHeader
                  count={showGroupCount ? group.items.length : undefined}
                  icon={groupIcon}
                  isOpen={isOpen}
                  label={group.label}
                  onToggle={() => toggleGroup(group.key)}
                />
                {isOpen ? group.items.map(renderCardItem) : null}
              </div>
            );
          })
        : items.map(renderCardItem)}
    </div>
  );

  const grid = (
    // `min-w-fit` keeps the header/rows sized to the columns so the host scrolls
    // horizontally when the columns exceed the container.
    <div
      aria-colcount={columnCount}
      className="min-w-fit border-t"
      data-grid-body=""
      role={tableRole}
    >
      <TableGridHeader
        actions={headerActions}
        columns={orderedColumns.map((column) => ({
          id: column.id,
          label: column.label,
          sortable: onSort != null && column.sortable === true,
          className: column.className,
          headerAlign: column.headerAlign,
          tooltip: column.tooltip,
          ariaLabel: column.ariaLabel,
          filterable: column.filterable,
          groupable: column.groupable,
          movable: column.movable,
        }))}
        enhancedHeaderInteractions={enhancedHeaderInteractions}
        gridTemplateColumns={renderedGridTemplateColumns}
        insideAriaTable
        leadingLabel={leadingLabel}
        leadingUtilityHeader={leadingUtilityHeader}
        leadingSortKey={onSort ? leadingSortKey : undefined}
        onSort={onSort ?? noopSort}
        reorder={
          onColumnOrderChange
            ? { columnOrder: fullColumnOrder, onReorder: onColumnOrderChange }
            : undefined
        }
        resize={resize}
        sortBy={sortBy ?? null}
        sortDir={sortDir}
      />
      {groups
        ? groups.map((group) => {
            const isOpen = !collapsedGroups.has(group.key);
            return (
              // A `role="table"` may only own rows and rowgroups, so the group
              // (its section header + its rows) is a rowgroup and the section
              // header itself is a row holding one cell spanning every column —
              // the same shape a native `<tbody>` + full-width `<td colspan>`
              // group header takes. The header keeps its own `aria-expanded`
              // button, so collapsing still reads as a disclosure.
              <div key={group.key} role="rowgroup">
                <div role="row">
                  <div
                    aria-colindex={leadColumnIndex}
                    aria-colspan={columnCount}
                    role="cell"
                  >
                    <GroupSectionHeader
                      count={showGroupCount ? group.items.length : undefined}
                      icon={groupIcon}
                      isOpen={isOpen}
                      label={group.label}
                      onToggle={() => toggleGroup(group.key)}
                    />
                  </div>
                </div>
                {isOpen ? group.items.map(renderRow) : null}
              </div>
            );
          })
        : items.map(renderRow)}
    </div>
  );

  // A caller that opted into NONE of the measured behaviours (card fallback,
  // fold fit) renders the bare grid — no wrapper, no observer —
  // so it stays structurally identical.
  if (!hasMeasuredContainer) {
    return grid;
  }

  // With any of those opt-ins, wrap in the measured container. The observed wrapper is
  // ALWAYS full-width (`w-full`, never `min-w-fit`): if the ref sat on the same
  // element the grid grows past with `min-w-fit`, the ResizeObserver would
  // measure the overflowed grid's intrinsic width — wider than 768 on a phone
  // whose columns overflow — so `containerWidth < 768` would never fire and the
  // card fallback would never render. The grid's own `min-w-fit` therefore lives
  // on an inner wrapper, so the host still scrolls horizontally to the grid's
  // intrinsic width while the outer wrapper reports the real available width. The
  // card list is full-width and never scrolls sideways.
  return (
    <div className="w-full" ref={containerRef}>
      {showCards ? cardList : <div className="min-w-fit">{grid}</div>}
    </div>
  );
}

export function GridTableCell({
  children,
  className,
  columnId,
  colIndex,
  cellRole = "cell",
  ...navigationProps
}: {
  children?: ReactNode;
  className?: string;
  /**
   * The ARIA role for this cell — `cell` inside a static `role="table"`,
   * `gridcell` inside a keyboard-navigable `role="grid"`. Defaults to `cell` so
   * every existing caller is unchanged; `GridTable` passes the role matching
   * the table role it rendered, because a `cell` inside a `grid` (or a
   * `gridcell` inside a `table`) is itself an ARIA violation.
   */
  cellRole?: "cell" | "gridcell";
  /**
   * Keyboard-navigation attributes, supplied wholesale by `GridTable` when
   * arrow-key cell navigation is on (and omitted entirely when it is off, so a
   * static table emits no extra DOM). Declared here rather than inferred from a
   * rest spread so `tabIndex` is a real, typed part of this component's
   * contract instead of an untyped passthrough.
   */
  "data-grid-cell"?: string;
  "data-grid-cell-key"?: string;
  onFocus?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  /**
   * The owning column's id, surfaced as `data-column-id` so a cell can be
   * targeted unambiguously (in tests or query selectors) by which column it
   * belongs to, independent of what the caller's renderer emits inside it.
   */
  columnId?: string;
  /**
   * 1-based grid-track index of this cell (ISS-4672). Defined → the cell becomes
   * a `role="cell"` announced with that `aria-colindex`, which is what pairs it
   * with the `columnheader` in the same track. Undefined → no roles, because a
   * `cell` outside a `role="row"` is itself an ARIA violation; a caller
   * rendering this outside a `GridTable` row must own the row/table roles before
   * passing an index.
   */
  colIndex?: number;
}) {
  return (
    <div
      aria-colindex={colIndex}
      className={cn(
        // ISS-5812: every data cell keeps the same `pl-3`, whether or not its
        // column is reorderable. ISS-5356 mirrored the header's 36px grip lane
        // onto every data cell so the label stayed above its own data; removing
        // the lane from the header removes the reason for it here too, and with
        // it the 24px indent every cell of every grid was carrying.
        "flex h-full min-w-0 items-center gap-2 border-l pr-3 pl-3",
        // Only a navigable cell is focusable, so only it needs a focus ring —
        // and it needs one, or keyboard navigation moves an invisible cursor
        // (WCAG 2.4.7 Focus Visible).
        navigationProps.tabIndex != null &&
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className
      )}
      data-column-id={columnId}
      role={colIndex == null ? undefined : cellRole}
      {...navigationProps}
    >
      {children}
    </div>
  );
}

// ISS-5813: the card half moved to its own module so this file could take the
// width budget without growing. Re-exported so every consumer's import path is
// unchanged — this is a split, not a contract change.
export {
  buildGridTableCardFields,
  GridEmptyValue,
  type GridTableCardField,
  GridTableCard,
  isEmptyCellValue,
} from "./grid-table-card";

function noopSort() {
  // Column sorting is not wired in this view yet.
}

/** Column id of the trailing row-actions column. */
export const ROW_ACTIONS_COLUMN_ID = "actions";

/**
 * The trailing row-actions column a dense table ends with: no visible header
 * label (the overflow buttons speak for themselves and a label would only add
 * noise to the header row), never sortable, and carrying an accessible name
 * because the column still owns a grid track that every row's action cell is
 * announced against (ISS-4672).
 *
 * Exported as one spec so the id, the "no visible label" decision, and the name
 * are picked once instead of re-declared per table — spread it and add the
 * caller's own `width` track. The name is deliberately just "Actions": a screen
 * reader has already said "row" before it reads the column, so "Row actions"
 * would stutter, and the menu button inside names itself per domain ("Branch
 * actions", "Component actions").
 */
export const ROW_ACTIONS_COLUMN: GridTableColumn = {
  id: ROW_ACTIONS_COLUMN_ID,
  label: "",
  ariaLabel: "Actions",
  sortable: false,
};

