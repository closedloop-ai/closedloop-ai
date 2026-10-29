import { documentsWindowedPage } from "@repo/app/documents/components/table/documents-windowed-population.fixtures";
import { DOCUMENT_TYPE_LABELS } from "@repo/app/documents/lib/document-type-labels";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  GRID_TABLE_V2_FAVORITE_TRACK,
  GridTableV2,
  type GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableChoiceCell,
  TableDateCell,
  TableFavoriteCell,
  TableIdentityCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  type ColumnMovePlacement,
  moveColumnPlacement,
} from "@repo/design-system/lib/column-order";
import {
  EMPTY_GRID_ROW_SELECTION,
  type GridRowSelection,
  type GridSelectionModifiers,
  reconcileGridRowSelection,
  resolveGridRowSelection,
  selectAllGridRows,
  toggleGridRowSelection,
} from "@repo/design-system/lib/grid-table-v2-selection";
import { FileIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  buildGroups,
  COLUMNS,
  DATA_COLUMN_WIDTH_PX,
  type GridStoryRow,
  LEAD_COLUMN_WIDTH_PX,
  ROWS,
  sortRows,
} from "./grid-table-v2-story-model";

/** Grouping examples own arrangement state while the production grid renders bands and rows. */
export function GroupedSectionsHarness({
  compact = false,
  initiallyClosed = false,
  nestedRows = false,
  population = "complete",
  initialGroupBy = null,
}: {
  compact?: boolean;
  initiallyClosed?: boolean;
  nestedRows?: boolean;
  population?: "complete" | "windowed" | "unknown";
  initialGroupBy?: string | null;
} = {}) {
  const [selection, setSelection] = useState<GridRowSelection>(
    EMPTY_GRID_ROW_SELECTION
  );
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [columnOrder, setColumnOrder] = useState(COLUMNS.map(({ id }) => id));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(COLUMNS.map(({ id }) => [id, DATA_COLUMN_WIDTH_PX]))
  );
  const [leadColumnWidth, setLeadColumnWidth] = useState(LEAD_COLUMN_WIDTH_PX);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [groupBy, setGroupBy] = useState<string | null>(initialGroupBy);
  const visibleRows = useMemo(
    () =>
      sortRows(
        population === "windowed" ? WINDOWED_PAGE.rows : ROWS,
        sortBy,
        sortDir
      ),
    [population, sortBy, sortDir]
  );
  const groups = useMemo(() => {
    if (population === "windowed" && groupBy === "status") {
      return WINDOWED_PAGE.bands.map((band) => ({
        ...band,
        items: visibleRows.filter((row) => row.status === band.label),
      }));
    }
    const roots = nestedRows
      ? visibleRows.filter((row) => row.id !== ROWS[1]?.id)
      : visibleRows;
    return buildGroups(roots, groupBy)?.map((group) =>
      population === "unknown" ? { ...group, count: null } : group
    );
  }, [groupBy, nestedRows, population, visibleRows]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(initiallyClosed ? [ROWS[0]?.status ?? ""] : [])
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(nestedRows ? [ROWS[0]?.id ?? ""] : [])
  );
  const gridTemplateColumns = [
    GRID_TABLE_V2_FAVORITE_TRACK,
    `${leadColumnWidth}px`,
    ...columnOrder.map((id) => `${columnWidths[id]}px`),
    GRID_TABLE_V2_ADD_FIELD_TRACK,
  ].join(" ");

  /** Pointer click and keyboard navigation, resolved by the one contract. */
  const selectRow = (
    row: GridStoryRow,
    event: GridSelectionModifiers,
    renderedRows: readonly GridStoryRow[]
  ) =>
    setSelection((current) =>
      resolveGridRowSelection(
        current,
        row.id,
        event,
        renderedRows.map(({ id }) => id)
      )
    );

  return (
    <div className="h-screen overflow-auto bg-background">
      <GridTableV2
        columnOrder={columnOrder}
        columns={COLUMNS}
        columnWidths={columnWidths}
        getChildren={nestedRows ? nestedChildren : undefined}
        getRowId={(row) => row.id}
        gridTemplateColumns={gridTemplateColumns}
        groupCollapse={{
          isCollapsed: (key) => collapsed.has(key),
          setCollapsed: (key, value) =>
            setCollapsed((current) => updateMembership(current, key, value)),
        }}
        groups={groups}
        headerActions={{
          getFilterContent: () => <p className="p-3 text-sm">Filter values</p>,
          onGroup: setGroupBy,
          onMove: (id, placement: ColumnMovePlacement) =>
            setColumnOrder((current) =>
              moveColumnPlacement(current, id, placement)
            ),
        }}
        isRowSelected={(row) => selection.selectedIds.has(row.id)}
        items={visibleRows}
        leadingColumnWidth={leadColumnWidth}
        leadingLabel="Artifact"
        leadingSortKey="name"
        leadingUtilityLabel="Favorite"
        mode={compact ? "compact" : undefined}
        onColumnWidthChange={(id, width) =>
          setColumnWidths((current) => ({ ...current, [id]: width }))
        }
        onLeadingColumnWidthChange={setLeadColumnWidth}
        onRenderedItemsChange={(renderedRows) =>
          setSelection((current) =>
            reconcileGridRowSelection(
              current,
              renderedRows.map((row) => row.id)
            )
          )
        }
        onRowClick={selectRow}
        onRowKeyboardNavigate={selectRow}
        onRowRangeDrag={selectRow}
        onRowSelectionToggle={(row) =>
          setSelection((current) => toggleGridRowSelection(current, row.id))
        }
        onSelectAllRows={(rows) =>
          setSelection(selectAllGridRows(rows.map(({ id }) => id)))
        }
        onSort={(columnId, direction) => {
          setSortBy(columnId);
          setSortDir(direction);
        }}
        renderCell={renderCell}
        renderLead={(row) => (
          <TableIdentityCell
            icon={FileIcon}
            slug={row.slug}
            title={row.title}
          />
        )}
        renderLeadingUtility={(row, context) => {
          const favorite = (
            <TableFavoriteCell
              favorited={favoriteIds.has(row.id)}
              itemLabel={row.title}
              onFavoriteChange={(favorited) =>
                setFavoriteIds((current) => {
                  const next = new Set(current);
                  if (favorited) {
                    next.add(row.id);
                  } else {
                    next.delete(row.id);
                  }
                  return next;
                })
              }
            />
          );
          // A phone row gives the star a 32px touch box inside the 44px row.
          return context.isNarrowList ? (
            <div className="size-8 shrink-0">{favorite}</div>
          ) : (
            favorite
          );
        }}
        rowExpansion={
          nestedRows
            ? {
                isExpanded: (key) => expanded.has(key),
                setExpanded: (key, value) =>
                  setExpanded((current) =>
                    updateMembership(current, key, value)
                  ),
              }
            : undefined
        }
        sortBy={sortBy}
        sortDir={sortDir}
      />
    </div>
  );
}

/** Canonical cells shared by this entry’s grid and compact compositions. */
function renderCell(columnId: string, row: GridStoryRow) {
  if (columnId === "type") {
    return <TableChoiceCell label={row.type} />;
  }
  if (columnId === "status") {
    return <TableChoiceCell label={row.status} />;
  }
  if (columnId === "owner") {
    return <TablePersonCell person={{ name: row.owner }} />;
  }
  if (columnId === "updated") {
    return <TableDateCell fullValue={row.updatedAt} value={row.updated} />;
  }
  return <GridEmptyValue />;
}

function updateMembership(
  current: ReadonlySet<string>,
  key: string,
  included: boolean
): ReadonlySet<string> {
  const next = new Set(current);
  if (included) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
}

function nestedChildren(row: GridStoryRow): GridStoryRow[] {
  const child = ROWS[1];
  if (row.id === ROWS[0]?.id && child) {
    return [child];
  }
  return [];
}

/**
 * One page of a windowed Documents population, paged by the production
 * section-aware plan: each band states its full population and only the band
 * whose rows began on an earlier page is marked continued. The fixture rows
 * borrow the grid fixture's remaining cells.
 */
const WINDOWED_PAGE = buildWindowedStoryPage();

type WindowedBand = Omit<GridTableV2Group<GridStoryRow>, "items">;

function buildWindowedStoryPage(): {
  bands: WindowedBand[];
  rows: GridStoryRow[];
} {
  const page = documentsWindowedPage();
  const documentsById = new Map(
    page.documents.map((document) => [document.id, document])
  );
  const rows: GridStoryRow[] = [];
  const bands = new Map<string, WindowedBand>();
  for (const [index, id] of page.pageIds.entries()) {
    const document = documentsById.get(id);
    const template = ROWS[index % ROWS.length];
    if (!(document && template)) {
      continue;
    }
    const status = ARTIFACT_STATUS_LABELS[document.status] ?? document.status;
    rows.push({
      ...template,
      id: document.id,
      slug: document.slug,
      status,
      title: document.title,
      // The row's type is the document's own, so it agrees with its slug.
      type: DOCUMENT_TYPE_LABELS[document.type],
    });
    if (!bands.has(document.status)) {
      bands.set(document.status, {
        count: page.sectionTotals.get(document.status) ?? null,
        isContinued: page.continuedSectionKeys.has(document.status),
        key: document.status,
        label: status,
      });
    }
  }
  return { bands: [...bands.values()], rows };
}
