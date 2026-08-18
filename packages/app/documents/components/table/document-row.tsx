"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  AssigneeCell,
  DueDateCell,
  PriorityCell,
} from "@repo/app/documents/components/table/cells/edit-cells";
import { NameCell } from "@repo/app/documents/components/table/cells/name-cell";
import { buildRankSlot } from "@repo/app/documents/components/table/cells/rank-slot";
import { ScoreCell } from "@repo/app/documents/components/table/cells/score-cell";
import {
  ParentCell,
  ProjectCell,
  TypeCell,
  UpdatedCell,
} from "@repo/app/documents/components/table/cells/static-cells";
import { TagsCell } from "@repo/app/documents/components/table/cells/tags-cell";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import type { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  ARTIFACT_COLUMN_LABELS,
  DocumentColumn as Col,
} from "@repo/app/shared/hooks/use-column-visibility";
import {
  GridTableCard,
  type GridTableCardField,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import {
  ariaCellProps,
  ariaRowProps,
  FIRST_COLUMN_INDEX,
  getDataColumnIndex,
} from "@repo/design-system/lib/grid-table-aria";
import { cn } from "@repo/design-system/lib/utils";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { EllipsisIcon } from "lucide-react";
import type { ReactNode } from "react";

// FEA-3866: below CARD_FALLBACK_BREAKPOINT the Documents tree falls back to a
// stacked card per row (the grid's `minmax(350px, 1fr)` lead + N×124px tracks
// can't collapse to a phone width). ISS-4788: this used to re-declare the 768
// literal locally "to match the GridTable card fallback"; it now imports the
// shared constant, so the Documents tree cannot silently drift away from the
// primitive it is deliberately mirroring (wongk review).

// ---- Unified row item type ----

/**
 * Discriminated union keyed on the row's actual artifact type (FEA-1763 /
 * PLN-874 Phase 2): `document` = DOCUMENT artifacts (all subtypes — PRD,
 * Plan, Feature; the subtype lives in `data.type`), `branch` = BRANCH
 * artifacts (PRs), `session` = SESSION artifacts. `project` rows are the
 * non-artifact grouping rows used by multi-project surfaces. Per-type
 * presentation (badge, icon, route, capabilities) comes from
 * `row-type-registry.ts`; cell renderers live under `table/cells/`.
 */
export type DocumentRowItem =
  | {
      kind: "document";
      data: DocumentRowData;
      children?: DocumentRowItem[];
    }
  | { kind: "project"; data: ProjectWithDetails; children?: DocumentRowItem[] }
  | {
      kind: "branch";
      data: Artifact;
      children?: DocumentRowItem[];
    }
  | {
      kind: "session";
      data: Artifact;
      children?: DocumentRowItem[];
    };

// ---- Column to cell mapping ----

const CELL_RENDERERS: Record<
  DocumentColumn,
  React.ComponentType<{ item: DocumentRowItem }>
> = {
  [Col.Type]: TypeCell,
  [Col.Parent]: ParentCell,
  [Col.DueDate]: DueDateCell,
  [Col.Assignee]: AssigneeCell,
  [Col.Priority]: PriorityCell,
  [Col.Score]: ScoreCell,
  [Col.Tags]: TagsCell,
  [Col.Updated]: UpdatedCell,
  [Col.Project]: ProjectCell,
};

// ---- Main row component ----

export type DocumentRowProps = {
  item: DocumentRowItem;
  visibleColumns: DocumentColumn[];
  showCheckbox?: boolean;
  isSelected?: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  /**
   * Row overflow ("More actions") menu. Each row supplies its own self-contained
   * menu (FEA-4242) — see `DocumentRowActions` / `ProjectRowActions`. Falls back
   * to an inert ellipsis affordance only when a caller omits it.
   */
  moreMenuContent?: React.ReactNode;
  /** When defined, renders a chevron for expand/collapse (grouped "All" view). */
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /**
   * Nesting depth of this row in the tree (0 = root). Each level indents the
   * name cell by one slot width so hierarchy is visible at any depth.
   */
  indentDepth?: number;
  /** Edit handlers for inline cell editing. */
  editHandlers?: RowEditHandlers;
  /** Parent entity title for this row, used by the Parent column cell. */
  parentTitle?: string;
  /** Parent entity route for this row, used by the Parent column cell. */
  parentHref?: string | null;
  /** Reserve the chevron slot even when the row has no children. */
  reserveChevronSlot?: boolean;
  /**
   * Reserve an empty rank slot so this row's grid (and therefore its indent)
   * stays aligned with sibling rows that render a rank slot. Used by child
   * rows on stack-rank surfaces: they are not themselves rankable (no
   * `rankInteractionMode`), but without the slot the 28px rank column on root
   * rows would exactly cancel one level of child indentation.
   */
  reserveRankSlot?: boolean;
  /** When true, checkboxes are always visible (not just on hover). */
  selectMode?: boolean;
  /**
   * Render the bottom border of this row. Defaults to true; tree groups pass
   * false for every row except the group's last visible one, so rows belonging
   * to the same root read as one visual block.
   */
  showBottomBorder?: boolean;
  /**
   * Stack-rank interaction state for this row (PRD-421 / PLN-755 Phase E).
   * Controls whether the rank slot at the start of the name cell is reserved
   * and, if so, what it renders:
   *  - `Enabled`         — render the `dragHandle` slot content (the parent
   *                        wraps the group in `<SortableTreeGroup>` and passes
   *                        the handle to the root row here).
   *  - `DisabledGrouped` — render a greyed handle with an explanatory tooltip.
   *  - `Hidden`          — column sort is active; show no rank slot.
   *  - undefined         — caller is not a stack-rank surface; no slot.
   * Children of a tree group should always receive `undefined` so the slot
   * stays consistent across the root + children grid.
   */
  rankInteractionMode?: RankInteractionMode;
  /**
   * Element rendered into the rank slot when `rankInteractionMode === Enabled`.
   * Supplied by `<SortableTreeGroup>` and wires `@dnd-kit` listeners /
   * attributes to the grip-vertical button.
   */
  dragHandle?: React.ReactNode;
  /**
   * ISS-4761: render this row with the shared `GridTable` ARIA table semantics
   * (ISS-4672) — `role="row"` on the grid, `role="cell"` plus the track's
   * `aria-colindex` on every cell — so a screen reader announces a body cell as
   * "Status, Active" instead of a loose "Active".
   *
   * Set ONLY when an ancestor carries `role="table"` and the paired
   * `DocumentTableHeader` was given the same opt-in: a `row` with no `table`
   * ancestor, or cells numbered from a different base than the header, are both
   * worse than no roles at all. Off ⇒ the prior role-less markup, byte for byte.
   */
  insideAriaTable?: boolean;
};

export function DocumentRow({
  item,
  visibleColumns,
  showCheckbox = false,
  isSelected = false,
  onSelectionChange,
  moreMenuContent,
  isExpanded,
  onToggleExpand,
  indentDepth = 0,
  editHandlers,
  parentTitle,
  parentHref,
  reserveChevronSlot = false,
  reserveRankSlot = false,
  selectMode,
  showBottomBorder = true,
  rankInteractionMode,
  dragHandle,
  insideAriaTable = false,
}: DocumentRowProps) {
  const params = useRouteParams();
  const buildOrgPath = useOrgPath();
  // Empty string (param absent or not a single string) falls through to the
  // row's own team id in computeHref().
  const activeTeamId = getStringRouteParam(params, "teamId") || undefined;

  const rankSlot = buildRankSlot(
    rankInteractionMode,
    dragHandle,
    reserveRankSlot
  );
  const gridTemplateColumns = getDocumentRowGridTemplateColumns(
    visibleColumns.length
  );

  function computeHref(): string | null {
    // Project rows are not artifacts: their route needs the team context, so
    // they stay outside the row-type registry.
    if (item.kind === "project") {
      const teamId = activeTeamId ?? item.data.teams[0]?.id;
      return teamId
        ? buildOrgPath(`/teams/${teamId}/projects/${item.data.id}`)
        : null;
    }
    const route = getRowTypeConfig(item)?.route ?? null;
    return route ? buildOrgPath(route) : null;
  }

  const href = computeHref();

  // FEA-3866: measure the row's own container so the tree falls back to a card
  // below the `md` width. `useContainerWidth` defaults to a wide box pre-measure
  // (and under SSR / jsdom), so the desktop grid is the first paint and never
  // flashes a card. The same NameCell cluster (checkbox, chevron/expand, rank
  // handle, status control, title link) and the same CELL_RENDERERS feed both
  // layouts, so grouping/tree/rank/inline-edit and the rendered content never
  // drift between the grid and the card.
  const { ref: containerRef, width: containerWidth } =
    useContainerWidth<HTMLDivElement>();
  const showCard = containerWidth < CARD_FALLBACK_BREAKPOINT;

  const nameCell = (
    <NameCell
      href={href}
      indentDepth={indentDepth}
      isExpanded={isExpanded}
      isSelected={isSelected}
      item={item}
      onSelectionChange={onSelectionChange}
      onToggleExpand={onToggleExpand}
      rankSlot={rankSlot}
      reserveChevronSlot={reserveChevronSlot}
      selectMode={selectMode}
      showCheckbox={showCheckbox}
    />
  );

  // The favorite + overflow (more-menu) affordances, rendered identically in the
  // grid's trailing cell and the card header. On touch they're always visible
  // (`touch:opacity-100`); on a mouse the row-hover reveal is unchanged.
  const moreMenu = (
    <>
      {item.kind !== "project" && (
        <FavoriteButton artifactId={item.data.id} size="sm" />
      )}
      {moreMenuContent ?? (
        <button
          aria-label="More actions"
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          type="button"
        >
          <EllipsisIcon className="h-4 w-4" />
        </button>
      )}
    </>
  );

  return (
    <RowEditContext.Provider
      value={{ ...(editHandlers ?? {}), parentHref, parentTitle }}
    >
      {/* The observed wrapper is ALWAYS full-width (`w-full`, never
          `min-w-fit`): if the ref sat on the element the grid grows past with
          `min-w-fit`, the ResizeObserver would measure the overflowed grid's
          intrinsic width — wider than 768 on a phone whose columns overflow — so
          `containerWidth < 768` would never fire and the card fallback would
          never render. The grid branch below carries its own `min-w-fit`, so the
          host still scrolls horizontally to the grid's intrinsic width while this
          wrapper reports the real available width. The card path is full-width
          and never scrolls sideways. Mirrors the GridTable fallback wrapper. */}
      <div className="w-full" ref={containerRef}>
        {showCard ? (
          <DocumentCardRow
            insideAriaTable={insideAriaTable}
            isSelected={isSelected}
            item={item}
            moreMenu={moreMenu}
            nameCell={nameCell}
            visibleColumns={visibleColumns}
          />
        ) : (
          <DocumentGridRow
            gridTemplateColumns={gridTemplateColumns}
            insideAriaTable={insideAriaTable}
            isSelected={isSelected}
            item={item}
            moreMenu={moreMenu}
            nameCell={nameCell}
            showBottomBorder={showBottomBorder}
            visibleColumns={visibleColumns}
          />
        )}
      </div>
    </RowEditContext.Provider>
  );
}

/**
 * Narrow-surface card for one Documents-tree row (FEA-3866). The header is the
 * same `NameCell` cluster the grid uses — so the selection checkbox, the tree
 * expand/collapse chevron, the rank handle, the status control, and the title
 * link all keep working — plus the favorite + overflow menu. The body lists the
 * visible data columns as key/value pairs via the same `CELL_RENDERERS`, so the
 * card and the grid row never drift. Built on the shared `GridTableCard` so the
 * radius/border/padding match the Agents, Sessions, and Branches cards.
 *
 * Grouping is untouched: `TreeGroupRows` still wraps rows in its group sections
 * and renders one `DocumentRow` per node, so the same cards nest under the same
 * collapsible group + tree structure the grid shows.
 *
 * Exported as the feature's `<Feature>Card` companion (FEA-3872) so an RN
 * adapter can render one document row as a card without the grid path.
 */
export function DocumentCard({
  item,
  visibleColumns,
  nameCell,
  moreMenu,
  isSelected,
}: {
  item: DocumentRowItem;
  visibleColumns: DocumentColumn[];
  nameCell: ReactNode;
  moreMenu: ReactNode;
  isSelected: boolean;
}) {
  const fields: GridTableCardField[] = visibleColumns.map((column) => {
    const CellRenderer = CELL_RENDERERS[column];
    return {
      key: column,
      label: ARTIFACT_COLUMN_LABELS[column],
      value: <CellRenderer item={item} />,
    };
  });
  return (
    // `group/row` keeps the NameCell's hover-reveal checkbox behaving as it does
    // in the grid; the checkbox itself carries `touch:opacity-100`. A selected
    // row tints the ring to match the grid's `bg-accent/40` selection state.
    <div className={cn("group/row", isSelected && "rounded-xl bg-accent/40")}>
      <GridTableCard
        fields={fields}
        header={
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center">{nameCell}</div>
            <div className="flex shrink-0 items-center">{moreMenu}</div>
          </div>
        }
      />
    </div>
  );
}

export function getDocumentRowGridTemplateColumns(
  visibleColumnCount: number
): string {
  return [
    "minmax(350px, 1fr)",
    ...Array.from({ length: visibleColumnCount }, () => "124px"),
    "88px",
  ].join(" ");
}

/**
 * ISS-4761: `data-column-id` for the tree's leading (Name) track. The data
 * columns carry their `DocumentColumn` id and the trailing track the shared
 * `ROW_ACTIONS_COLUMN_ID`, so every cell in the row can be targeted by which
 * column it belongs to — the same handle `GridTableCell` gives the other dense
 * tables, and the one a test must use because a sortable header's accessible
 * name is not a plain label (FEA-4021's drag handle injects its own text).
 */
const LEAD_COLUMN_ID = "name";

/**
 * ISS-4761: total grid tracks one Documents-tree row occupies — the leading
 * (Name) track, one per visible data column, and the trailing More-menu track.
 * It is also the trailing track's own 1-based `aria-colindex` (it is the last
 * one), the table's `aria-colcount`, and the `aria-colspan` of the narrow card
 * fallback's single full-width cell.
 *
 * Derived from the SAME `grid-table-aria` arithmetic the shared header and
 * `GridTable` body use, rather than a local `+ 2`: the header/body pairing a
 * screen reader relies on holds only while both sides number the tracks
 * identically, and this table's template (`getDocumentRowGridTemplateColumns`)
 * carries the extra trailing track `GridTable`'s own count does not.
 */
export function getDocumentTableColumnCount(
  visibleColumnCount: number
): number {
  return getDataColumnIndex(FIRST_COLUMN_INDEX, visibleColumnCount);
}

/**
 * The wide-surface grid layout for one Documents-tree row: the leading Name
 * cell, one cell per visible data column, and the trailing More-menu cell.
 * Extracted from {@link DocumentRow} so that component stays under the
 * cognitive-complexity cap once the card fallback and the ISS-4761 table
 * semantics both branch inside it.
 */
function DocumentGridRow({
  gridTemplateColumns,
  insideAriaTable,
  isSelected,
  item,
  moreMenu,
  nameCell,
  showBottomBorder,
  visibleColumns,
}: {
  gridTemplateColumns: string;
  insideAriaTable: boolean;
  isSelected: boolean;
  item: DocumentRowItem;
  moreMenu: ReactNode;
  nameCell: ReactNode;
  showBottomBorder: boolean;
  visibleColumns: DocumentColumn[];
}) {
  return (
    <div
      className={`group/row relative grid min-h-11 min-w-fit ${isSelected ? "bg-accent/40 hover:bg-accent/60" : "bg-background hover:bg-muted/40"}`}
      {...ariaRowProps(insideAriaTable)}
      style={{ gridTemplateColumns }}
    >
      {showBottomBorder && (
        // Decorative: an absolutely-positioned divider, not content. Hidden from
        // assistive tech so it is never mistaken for a cell of the row it sits
        // inside (ISS-4761).
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 border-b"
        />
      )}
      <div
        {...ariaCellProps(insideAriaTable, FIRST_COLUMN_INDEX)}
        data-column-id={LEAD_COLUMN_ID}
      >
        {nameCell}
      </div>

      {visibleColumns.map((column, index) => {
        const CellRenderer = CELL_RENDERERS[column];
        return (
          <div
            {...ariaCellProps(
              insideAriaTable,
              getDataColumnIndex(FIRST_COLUMN_INDEX, index)
            )}
            data-column-id={column}
            key={column}
          >
            <CellRenderer item={item} />
          </div>
        );
      })}

      {/* More menu */}
      <div
        {...ariaCellProps(
          insideAriaTable,
          getDocumentTableColumnCount(visibleColumns.length)
        )}
        data-column-id={ROW_ACTIONS_COLUMN_ID}
      >
        <div className="flex h-full min-h-11 items-center border-l px-1 py-2">
          {moreMenu}
        </div>
      </div>
    </div>
  );
}

/**
 * The narrow-surface card for one Documents-tree row, plus the ARIA wrapper it
 * needs when the table declares semantics (ISS-4761).
 *
 * The card is a different reading order, but it is still ONE row of this table
 * and — unlike `GridTable`, which swaps the whole table for a card list — the
 * fallback here is decided per row while the `role="table"` wrapper and its
 * header stay put. So it declares itself a row holding a single cell spanning
 * every track: the same shape `GridTable` gives a group-header row, and the
 * shape that keeps `aria-required-children` satisfied at any width.
 *
 * Opted out, it renders the bare card with no wrapper elements at all, so the
 * prior DOM is unchanged rather than merely un-annotated.
 */
function DocumentCardRow({
  insideAriaTable,
  isSelected,
  item,
  moreMenu,
  nameCell,
  visibleColumns,
}: {
  insideAriaTable: boolean;
  isSelected: boolean;
  item: DocumentRowItem;
  moreMenu: ReactNode;
  nameCell: ReactNode;
  visibleColumns: DocumentColumn[];
}) {
  const card = (
    <DocumentCard
      isSelected={isSelected}
      item={item}
      moreMenu={moreMenu}
      nameCell={nameCell}
      visibleColumns={visibleColumns}
    />
  );
  if (!insideAriaTable) {
    return card;
  }
  return (
    <div {...ariaRowProps(insideAriaTable)}>
      <div
        {...ariaCellProps(
          insideAriaTable,
          FIRST_COLUMN_INDEX,
          getDocumentTableColumnCount(visibleColumns.length)
        )}
      >
        {card}
      </div>
    </div>
  );
}
