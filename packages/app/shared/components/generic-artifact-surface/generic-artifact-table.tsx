"use client";

import { useGridValueAlignment } from "@repo/app/shared/feature-flags/use-grid-value-alignment";
import { ARTIFACT_IDENTITY_COLUMN_WIDTH_PX } from "@repo/app/shared/lib/column-width";
import {
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  GRID_TABLE_V2_FAVORITE_TRACK,
  GridTableV2,
  type GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableAddFieldDialog,
  type TableCustomFieldDraft,
  type TableCustomFieldReferenceSource,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  TableFavoriteCell,
  type TablePerson,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  type ColumnLayoutViewState,
  resolveColumnLayout,
} from "@repo/design-system/lib/column-layout";
import {
  type ColumnMovePlacement,
  moveColumnPlacement,
} from "@repo/design-system/lib/column-order";
import {
  type ColumnDefinition,
  ColumnFieldKind,
  createColumnRegistry,
} from "@repo/design-system/lib/column-registry";
import {
  EMPTY_GRID_ROW_SELECTION,
  type GridRowSelection,
  type GridSelectionModifiers,
  reconcileGridRowSelection,
  resolveGridRowSelection,
  selectAllGridRows,
  toggleGridRowSelection,
} from "@repo/design-system/lib/grid-table-v2-selection";
import { isPriorityValue } from "@repo/design-system/lib/priority-order";
import {
  BotIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  PlusIcon,
  SquareCheckIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { ArtifactCell } from "./artifact-cell";
import {
  ArtifactBulkActionBar,
  ArtifactSelectionAnnouncer,
} from "./bulk-action-bar";
import { ColumnFilterContent } from "./column-filter-content";
import { initialCustomFieldValue } from "./custom-field-cells";
import { demoArtifactBulkActions } from "./demo-bulk-actions";
import { EditableArtifactIdentityCell } from "./editable-cells";
import {
  type ArtifactCustomFieldDefinition,
  type ArtifactRow,
  artifactColumnDefinitions,
  artifactPeople,
  DEFAULT_CUSTOM_COLUMN_WIDTH_PX,
  initialArtifactRows,
  initialCustomFields,
} from "./fixtures";
import {
  genericArtifactStatusCapability,
  genericArtifactStatusForRoot,
} from "./generic-artifact-status";
import {
  buildGroups,
  cloneArtifact,
  columnLabel,
  filterArtifacts,
  filterOptions,
  setMembership,
  sortArtifacts,
  toggleArrayValue,
  uniqueFieldId,
} from "./model";

export function GenericArtifactTableDemo({
  initialFields = initialCustomFields,
}: {
  initialFields?: readonly ArtifactCustomFieldDefinition[];
}) {
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>(() =>
    initialArtifactRows.map(cloneArtifact)
  );
  const [customFields, setCustomFields] = useState<
    ArtifactCustomFieldDefinition[]
  >(() => [...initialFields]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(
    () => new Set(["artifact-1"])
  );
  const [selection, setSelection] = useState<GridRowSelection>(
    EMPTY_GRID_ROW_SELECTION
  );
  const selectedIds = selection.selectedIds;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [columnOrder, setColumnOrder] = useState(() =>
    artifactColumnDefinitions.map((definition) => definition.id)
  );
  // OVERRIDES only, not the widths themselves: every column's own width comes
  // from its declaration, and this holds just the ones a reader has dragged.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [leadingColumnWidth, setLeadingColumnWidth] = useState(
    ARTIFACT_IDENTITY_COLUMN_WIDTH_PX
  );
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const alignValuesToColumn = useGridValueAlignment();

  const columnDefinitions = useMemo<readonly ColumnDefinition[]>(
    () => [
      ...artifactColumnDefinitions,
      ...customFields.map((field) => ({
        filterable: true,
        id: field.id,
        // A field the reader invented at runtime: the registry cannot police
        // what its cell holds, and this demo's field vocabulary is not the
        // registry's kind set.
        kind: ColumnFieldKind.Custom,
        label: field.label,
        sortable: true,
        tooltip: `${field.type} field: ${field.label}`,
        // The field's own declared width when it has one; a field a reader
        // invented at runtime has none and takes the default.
        width: {
          default: field.defaultWidthPx ?? DEFAULT_CUSTOM_COLUMN_WIDTH_PX,
        },
      })),
    ],
    [customFields]
  );
  // ISS-9095 contract items 1 and 2: one declaration set in, one layout out. The
  // visible columns, the track string, the order and the widths all come from
  // `resolveColumnLayout`, so a column and its track cannot come apart the way
  // they could while this file derived each of the four beside the others.
  //
  // Memoized rather than built in the render body. `createColumnRegistry`
  // validates and FREEZES the whole set and emits fresh `GridTableV2Column`
  // objects, so constructing it per render hands `GridTableV2` a new column
  // identity on every pass — and the grid's own cell-entry, collapsed-group and
  // roving-focus state is keyed off those columns.
  const registry = useMemo(
    () => createColumnRegistry(columnDefinitions),
    [columnDefinitions]
  );
  // Taken as a function of the order so a move can resolve the layout for the
  // order it is actually moving against, rather than the one the last render
  // closed over.
  const resolveLayoutForOrder = useCallback(
    (order: readonly string[]) =>
      resolveColumnLayout(
        registry,
        { columnOrder: order, columnWidths } satisfies ColumnLayoutViewState,
        {
          leadingTracks: [
            GRID_TABLE_V2_FAVORITE_TRACK,
            `${leadingColumnWidth}px`,
          ],
          trailingTracks: [GRID_TABLE_V2_ADD_FIELD_TRACK],
        }
      ),
    [columnWidths, leadingColumnWidth, registry]
  );
  const columnLayout = useMemo(
    () => resolveLayoutForOrder(columnOrder),
    [columnOrder, resolveLayoutForOrder]
  );
  const columns = columnLayout.columns;
  const visibleArtifacts = useMemo(
    () => sortArtifacts(filterArtifacts(artifacts, filters), sortBy, sortDir),
    [artifacts, filters, sortBy, sortDir]
  );
  const groups = useMemo(
    () => buildGroups(visibleArtifacts, groupBy),
    [groupBy, visibleArtifacts]
  );
  const gridTemplateColumns = columnLayout.gridTemplateColumns;

  const updateArtifact = (
    artifactId: string,
    patch: Partial<ArtifactRow>,
    message?: string
  ) => {
    const previous = artifacts.find((artifact) => artifact.id === artifactId);
    if (!previous) {
      return;
    }
    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === artifactId ? { ...artifact, ...patch } : artifact
      )
    );
    if (message) {
      toast.success(message, {
        action: {
          label: "Undo",
          onClick: () =>
            setArtifacts((current) =>
              current.map((artifact) =>
                artifact.id === artifactId ? previous : artifact
              )
            ),
        },
      });
    }
  };

  /**
   * Pointer click AND keyboard navigation both land here, and both hand the
   * decision to the shared `resolveGridRowSelection` contract, so a Shift-click
   * and a `Shift+ArrowDown` cannot drift into two meanings (ISS-9461). `renderedRows`
   * is the grid's own painted order; `visibleArtifacts` cannot stand in for it,
   * because grouping reorders rows and the collapsed-group set is `GridTableV2`'s
   * internal state, so slicing this file's list selects rows the user never
   * traversed and, under a collapsed group, cannot see.
   */
  const handleArtifactSelection = (
    artifact: ArtifactRow,
    event: GridSelectionModifiers,
    renderedRows: readonly ArtifactRow[]
  ) =>
    setSelection((current) =>
      resolveGridRowSelection(
        current,
        artifact.id,
        event,
        renderedRows.map((row) => row.id)
      )
    );

  /** `Space` on a focused row — the same toggle the Ctrl/Cmd chord resolves to. */
  const toggleArtifactSelection = (artifact: ArtifactRow) =>
    setSelection((current) => toggleGridRowSelection(current, artifact.id));

  /**
   * `Ctrl/Cmd+A`. The grid hands back the rows it RENDERED, so "visible" here is
   * the filtered, sorted list minus anything inside a collapsed group — never
   * the whole dataset, and never a row the user cannot see.
   */
  const selectAllVisibleArtifacts = (rows: readonly ArtifactRow[]) =>
    setSelection(selectAllGridRows(rows.map((row) => row.id)));

  /**
   * Clearing UNMOUNTS the bar holding the button the user just pressed, and the
   * browser drops focus on `<body>` when the focused node is removed — the same
   * stranding the grid's own cell-entry guard exists to undo. Focus is handed
   * back BEFORE the re-render that removes the bar, to the grid's roving tab
   * stop: the one cell carrying `tabindex="0"`, which is where the user was.
   */
  const clearSelection = () => {
    setSelection(EMPTY_GRID_ROW_SELECTION);
    surfaceRef.current
      ?.querySelector<HTMLElement>(ROVING_TAB_STOP_SELECTOR)
      ?.focus();
  };

  /**
   * The rail's partial-failure contract: narrow the selection to the rows a
   * command did NOT change. `reconcileGridRowSelection` is the same rule the
   * rendered-item callback below uses, so a retained selection and a filtered
   * one settle identically instead of through two intersections.
   */
  const retainSelection = (rowIds: readonly string[]) =>
    setSelection((current) => reconcileGridRowSelection(current, [...rowIds]));

  const favoriteSelected = () => {
    setFavoriteIds((current) => new Set([...current, ...selectedIds]));
    toast.success(`${selectedIds.size} favorited`);
  };

  const assignOwnerToSelected = (owner: TablePerson) => {
    setArtifacts((current) =>
      current.map((artifact) =>
        selectedIds.has(artifact.id) ? { ...artifact, owner } : artifact
      )
    );
    toast.success(`Owner updated to ${owner.name}`);
  };

  // Moves are expressed against the RENDERED order and merged back through
  // `toPersistedColumnOrder`, the same round trip the header's drag takes, so a
  // move can never drop a column the layout is not currently painting.
  const moveColumn = (columnId: string, placement: ColumnMovePlacement) =>
    setColumnOrder((current) => {
      const previousLayout = resolveLayoutForOrder(current);
      return previousLayout.toPersistedColumnOrder(
        moveColumnPlacement(previousLayout.columnOrder, columnId, placement)
      );
    });

  const createCustomField = (field: TableCustomFieldDraft) => {
    const id = uniqueFieldId(field.label, columns);
    const nextField: ArtifactCustomFieldDefinition = { ...field, id };
    setCustomFields((current) => [...current, nextField]);
    setColumnOrder((current) => [...current, id]);
    setArtifacts((current) =>
      current.map((artifact, index) => ({
        ...artifact,
        customValues: {
          ...artifact.customValues,
          [id]: initialCustomFieldValue(nextField, artifact, index),
        },
      }))
    );
    toast.success(`${field.label} field added`);
  };

  return (
    <div className="h-screen overflow-auto bg-background" ref={surfaceRef}>
      <GridTableV2
        alignValuesToColumn={alignValuesToColumn}
        canDragRow={(artifact) =>
          groupBy !== "status" ||
          genericArtifactStatusCapability(artifact).editable
        }
        canDropOnGroup={(artifact, group) =>
          canApplyGroupChange(artifact, group, groupBy)
        }
        columnOrder={columnLayout.columnOrder}
        columns={columns}
        columnWidths={columnLayout.columnWidths}
        getRowId={(artifact) => artifact.id}
        gridTemplateColumns={gridTemplateColumns}
        groups={groups}
        headerActions={{
          getFilterContent: (columnId) => (
            <ColumnFilterContent
              columnId={columnId}
              onToggle={(value) =>
                setFilters((current) => ({
                  ...current,
                  [columnId]: toggleArrayValue(current[columnId] ?? [], value),
                }))
              }
              options={filterOptions(columnId, artifacts)}
              representedKinds={[
                ...new Set(artifacts.map((artifact) => artifact.kind)),
              ]}
              selectedValues={filters[columnId] ?? []}
            />
          ),
          onGroup: (columnId) => {
            setGroupBy(columnId);
            toast.success(`Grouped by ${columnLabel(columnId, columns)}`, {
              action: { label: "Ungroup", onClick: () => setGroupBy(null) },
            });
          },
          onMove: moveColumn,
        }}
        isRowSelected={(artifact) => selectedIds.has(artifact.id)}
        items={visibleArtifacts}
        leadingColumnWidth={leadingColumnWidth}
        leadingLabel="Artifact"
        leadingSortKey="name"
        leadingTooltip="Optional column header tool tip..."
        leadingUtilityLabel="Favorite"
        onColumnOrderChange={(visibleOrder) =>
          setColumnOrder(columnLayout.toPersistedColumnOrder(visibleOrder))
        }
        onColumnWidthChange={(columnId, widthPx) =>
          setColumnWidths((current) => ({ ...current, [columnId]: widthPx }))
        }
        onGroupDrop={
          groupBy
            ? (artifact, group) =>
                applyGroupChange(artifact, group, groupBy, updateArtifact)
            : undefined
        }
        onLeadingColumnWidthChange={setLeadingColumnWidth}
        onRenderedItemsChange={(renderedArtifacts) =>
          setSelection((current) =>
            reconcileGridRowSelection(
              current,
              renderedArtifacts.map((artifact) => artifact.id)
            )
          )
        }
        onRowClick={handleArtifactSelection}
        onRowKeyboardNavigate={handleArtifactSelection}
        onRowSelectionToggle={toggleArtifactSelection}
        onSelectAllRows={selectAllVisibleArtifacts}
        onSort={(columnId, direction) => {
          setSortBy(columnId);
          setSortDir(direction);
        }}
        renderCell={(columnId, artifact) => (
          <ArtifactCell
            artifact={artifact}
            columnId={columnId}
            customFields={customFields}
            onArtifactChange={updateArtifact}
          />
        )}
        renderLead={(artifact) => (
          <EditableArtifactIdentityCell
            artifact={artifact}
            onOpen={() => toast.info(`Opened ${artifact.slug}`)}
            onTitleChange={(title) =>
              updateArtifact(artifact.id, { title }, "Artifact name updated")
            }
          />
        )}
        renderLeadingUtility={(artifact) => (
          <TableFavoriteCell
            favorited={favoriteIds.has(artifact.id)}
            itemLabel={artifact.title}
            onFavoriteChange={(favorited) =>
              setFavoriteIds((current) =>
                setMembership(current, artifact.id, favorited)
              )
            }
          />
        )}
        sortBy={sortBy}
        sortDir={sortDir}
        trailingHeader={
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Add field"
                className="flex size-full items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                onClick={() => setAddFieldOpen(true)}
                type="button"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add field</TooltipContent>
          </Tooltip>
        }
      />
      <TableAddFieldDialog
        onCreate={createCustomField}
        onOpenChange={setAddFieldOpen}
        open={addFieldOpen}
        referenceSources={GRID_TABLE_REFERENCE_SOURCES}
      />
      {/* After the grid in DOM order, so every bulk action sits in the
        sequential tab order and AC5's "reachable without a pointer" holds. It
        is NOT one Tab away: a cell's CONTENT is supplied by this file's render
        props and those controls are ordinarily tabbable, so Tab walks them
        first — 30 presses from a first-row cell across three fixture rows.
        Taking them out of the sequence is the roving-tabindex half of the
        shared cell-entry model and belongs to `GridTableV2`, which owns the tab
        order; a host cannot do it from out here. */}
      <ArtifactSelectionAnnouncer count={selectedIds.size} />
      {selectedIds.size > 0 ? (
        <ArtifactBulkActionBar
          actions={demoArtifactBulkActions({
            count: selectedIds.size,
            onAssignOwner: assignOwnerToSelected,
            onFavorite: favoriteSelected,
            people: artifactPeople,
          })}
          onClear={clearSelection}
          onRetainSelection={retainSelection}
          rowIds={[...selectedIds]}
        />
      ) : null}
    </div>
  );
}

const GRID_TABLE_REFERENCE_SOURCES: readonly TableCustomFieldReferenceSource[] =
  [
    { icon: Layers2Icon, label: "Artifacts", value: "Artifacts" },
    { icon: HistoryIcon, label: "Sessions", value: "Sessions" },
    { icon: SquareCheckIcon, label: "Issues", value: "Issues" },
    { icon: GitBranchIcon, label: "Branches", value: "Branches" },
    { icon: FileIcon, label: "Documents", value: "Documents" },
    {
      icon: BotIcon,
      label: "Agentic Components",
      value: "Agentic Components",
    },
    { icon: Layers2Icon, label: "Projects", value: "Projects" },
  ];

function applyGroupChange(
  artifact: ArtifactRow,
  group: GridTableV2Group<ArtifactRow>,
  groupBy: string,
  updateArtifact: (
    artifactId: string,
    patch: Partial<ArtifactRow>,
    message?: string
  ) => void
) {
  if (groupBy === "status") {
    if (!genericArtifactStatusCapability(artifact).editable) {
      return;
    }
    const status = genericArtifactStatusForRoot(artifact, group.key);
    if (status === null) {
      return;
    }
    updateArtifact(
      artifact.id,
      { status, statusRaw: undefined },
      `${artifact.slug} moved to ${group.label}`
    );
  } else if (groupBy === "owner") {
    const owner = artifactPeople.find((person) => person.name === group.key);
    if (owner) {
      updateArtifact(artifact.id, { owner }, `Owner updated to ${owner.name}`);
    }
  } else if (groupBy === "priority" && isPriorityValue(group.key)) {
    updateArtifact(
      artifact.id,
      { priority: group.key },
      `Priority updated to ${group.label}`
    );
  }
}

function canApplyGroupChange(
  artifact: ArtifactRow,
  group: GridTableV2Group<ArtifactRow>,
  groupBy: string | null
): boolean {
  if (groupBy === "status") {
    return (
      genericArtifactStatusCapability(artifact).editable &&
      genericArtifactStatusForRoot(artifact, group.key) !== null
    );
  }
  if (groupBy === "owner") {
    return artifactPeople.some((person) => person.name === group.key);
  }
  return groupBy === "priority" && isPriorityValue(group.key);
}

/**
 * The grid's single roving tab stop. `GridTableV2` puts `tabindex="0"` on
 * exactly one `[data-grid-cell]` — the cell that last held focus — so this
 * resolves to where the keyboard user was without this file tracking it.
 */
const ROVING_TAB_STOP_SELECTOR = '[data-grid-cell][tabindex="0"]';
