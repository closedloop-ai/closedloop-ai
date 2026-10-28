"use client";

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { TAG_COLOR_PALETTE } from "@repo/app/shared/components/tag-color-picker";
import {
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  GRID_TABLE_V2_FAVORITE_TRACK,
} from "@repo/design-system/components/ui/grid-table-v2";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { resolveColumnLayout } from "@repo/design-system/lib/column-layout";
import {
  type ColumnMovePlacement,
  moveColumnPlacement,
} from "@repo/design-system/lib/column-order";
import {
  ColumnFieldKind,
  createColumnRegistry,
} from "@repo/design-system/lib/column-registry";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  genericArtifactStatusCapability,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusForKey,
  genericArtifactStatusLabel,
  genericArtifactStatusMatchesAny,
  genericArtifactStatusOptions,
} from "../../generic-artifact-status";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "../fixtures";
import { buildBaseColumnFilterGroups } from "./artifact-column-filters";
import {
  buildCreatedArtifact,
  defaultArtifactCreationConfig,
} from "./artifact-creation";
import {
  formatArtifactHierarchyMoveMessage,
  moveArtifactHierarchySelectionToProject,
  moveArtifactHierarchySubtree,
} from "./artifact-hierarchy";
import {
  type ArtifactManualMoveDirection,
  artifactManualMoveTarget,
} from "./artifact-hierarchy-view";
import { useArtifactListBulkActions } from "./artifact-list-bulk-actions";
import {
  buildCustomFieldFilterGroups,
  matchesCustomFieldFilters,
} from "./artifact-list-custom-field-model";
import { resolveArtifactGroupDestination } from "./artifact-list-group-drop";
import {
  type ArtifactListColumn,
  buildExtensionFilterGroups,
  buildFilterViewModel,
  columnWidthBounds,
  type GenericArtifactListShellProps,
  genericArtifactColumns,
  genericSummaryMetricDefinitions,
  INITIAL_TAG_DEFINITIONS,
  isCustomFieldGroupable,
  isCustomFieldSortable,
  matchesExtensionFilters,
  RELATED_SESSIONS_COLUMN_ID,
  type TagDefinition,
  type TagEditorContextValue,
} from "./artifact-list-model";
import { defaultRelatedSessionsForArtifact } from "./artifact-list-related-sessions";
import { useArtifactListShellDerived } from "./artifact-list-shell-derived";
import { useArtifactListShellState } from "./artifact-list-shell-state";
import { buildRelatedSessionsColumn } from "./related-sessions-column";
import { useArtifactListGridSelection } from "./use-artifact-list-grid-selection";

export function useGenericArtifactListController({
  addArtifactOpen: controlledAddArtifactOpen,
  additionalColumns = [],
  artifacts: initialArtifacts,
  boardRootOnly = false,
  currentUser = { id: "Ottilie Eastwick", name: "Ottilie Eastwick" },
  controlledFavoriteIds,
  controlledFavoritesUnavailable = false,
  controlledPendingFavoriteIds,
  controlledArtifacts = false,
  textFilter,
  routeState,
  persistenceKey,
  columnCapabilities,
  buildSummaryMetrics: buildConfiguredSummaryMetrics,
  creationConfig = defaultArtifactCreationConfig,
  dateFilterLabel = "Artifact updated within time period",
  defaultVisibleColumnIds,
  excludedColumnIds = [],
  hierarchy,
  inlineCreate,
  manualOrdering = false,
  projectMove,
  legacyColumnAliases,
  legacyMetricAliases,
  onAddArtifactOpenChange,
  onArtifactsChange,
  onOpenArtifact,
  onOpenArtifactHref,
  relatedSessionsForArtifact = defaultRelatedSessionsForArtifact,
  relatedSessionsColumn: hostRelatedSessionsColumn,
  selectionNoun = { plural: "artifacts", singular: "artifact" },
  statusBoard = {
    editable: true,
  },
  showAddArtifactButton = true,
  showBoardAddButton = showAddArtifactButton,
  showAddFieldButton = true,
  defaultGroupBy = "none",
  openCreatedArtifactAfterCreate = true,
  hasDateDimension,
  defaultDateRange,
  showDateRangeControl = true,
  showSummaryCards = true,
  variant = "page",
  summaryMetricDefinitions = genericSummaryMetricDefinitions,
}: GenericArtifactListShellProps) {
  const [localArtifacts, setArtifactsState] = useState<GenericArtifact[]>([
    ...initialArtifacts,
  ]);
  const artifacts = useMemo(
    () => (controlledArtifacts ? [...initialArtifacts] : localArtifacts),
    [controlledArtifacts, initialArtifacts, localArtifacts]
  );
  const setArtifacts: React.Dispatch<React.SetStateAction<GenericArtifact[]>> =
    useCallback(
      (update) => {
        setArtifactsState((current) => {
          const next = typeof update === "function" ? update(current) : update;
          if (onArtifactsChange) {
            queueMicrotask(() => onArtifactsChange(next));
          }
          return next;
        });
      },
      [onArtifactsChange]
    );
  useEffect(() => {
    if (onArtifactsChange) {
      setArtifactsState([...initialArtifacts]);
    }
  }, [initialArtifacts, onArtifactsChange]);
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [tagDefinitions, setTagDefinitions] = useState<TagDefinition[]>(
    INITIAL_TAG_DEFINITIONS
  );
  const relatedSessionsColumn =
    hostRelatedSessionsColumn ??
    buildRelatedSessionsColumn(relatedSessionsForArtifact, onOpenArtifactHref);
  const extensionColumns = (
    excludedColumnIds.includes(RELATED_SESSIONS_COLUMN_ID)
      ? additionalColumns
      : [relatedSessionsColumn, ...additionalColumns]
  ).map((column) => ({ ...column, ...columnCapabilities?.[column.id] }));
  const configuredColumns = [
    ...genericArtifactColumns.flatMap((column) => {
      if (
        column.id === "comments" &&
        !excludedColumnIds.includes(RELATED_SESSIONS_COLUMN_ID)
      ) {
        return [relatedSessionsColumn, column];
      }
      return [column];
    }),
    ...additionalColumns,
  ]
    .filter((column) => !excludedColumnIds.includes(column.id))
    .map((column) => ({ ...column, ...columnCapabilities?.[column.id] }));
  const {
    activeSavedViewId,
    addArtifactOpen,
    addFieldOpen,
    applySavedView,
    artifactColumnWidth,
    boardCreationStatus,
    columnOrder,
    columnWidths,
    collapsedGroups,
    setCollapsedGroups,
    customFieldFilters,
    dateDimension,
    extensionFilters,
    favoriteArtifactIds: localFavoriteArtifactIds,
    filterMenuOpen,
    filters,
    groupBy,
    groupOrder,
    inlineDraftContext,
    layout,
    page,
    pageSize,
    saveCurrentView,
    savedViews,
    secondaryGroupBy,
    secondaryGroupOrder,
    selectedArtifactIds,
    selectionAnchorId,
    setAddArtifactOpen,
    setAddFieldOpen,
    setArtifactColumnWidth,
    setArtifactListLayout,
    setBoardCreationStatus,
    setColumnOrder,
    setColumnWidths,
    setCustomFieldFilters,
    setExtensionFilters,
    setFavoriteArtifactIds,
    setFilterMenuOpen,
    setFilters,
    setGroupBy,
    setGroupOrder,
    setInlineDraftContext,
    setPage,
    setPageSize,
    setSecondaryGroupBy,
    setSecondaryGroupOrder,
    setSelectedArtifactIds,
    setShowEmptyGroups,
    setShowEmptySubgroups,
    setSortActive,
    setSortBy,
    setSortDir,
    setVisibleColumnIds,
    setVisibleMetricKeys,
    showEmptyGroups,
    showEmptySubgroups,
    sortActive,
    sortBy,
    sortDir,
    visibleColumnIds,
    visibleMetricKeys,
  } = useArtifactListShellState({
    routeState,
    persistenceKey,
    configuredColumns,
    controlledAddArtifactOpen,
    // One truth, resolved once. `showDateRangeControl` is the presentational
    // predecessor and stays accepted as its alias: hiding the picker has always
    // meant "this surface has no date dimension", and two booleans that can
    // disagree is the defect ISS-10479 reports, not its fix.
    dateDimensionPresent: hasDateDimension ?? showDateRangeControl,
    defaultDateRange,
    defaultGroupBy,
    defaultVisibleColumnIds,
    legacyColumnAliases,
    legacyMetricAliases,
    onAddArtifactOpenChange,
    summaryMetricDefinitions,
  });
  const favoriteArtifactIds = controlledFavoriteIds ?? localFavoriteArtifactIds;
  const columnDefinitions: ArtifactListColumn[] = [
    ...configuredColumns,
    ...customFields.map((field) => ({
      filterable: true,
      groupable: isCustomFieldGroupable(field),
      id: field.id,
      // A field the user invented at runtime: the registry cannot police what
      // its cell holds, and this prototype's own type vocabulary is not the
      // registry's kind set.
      kind: ColumnFieldKind.Custom,
      label: field.label,
      sortable: isCustomFieldSortable(field),
      width: columnWidthBounds(180),
    })),
  ];
  // ISS-9315: one declaration set in, one layout out. The visible columns,
  // their track string, their order, their widths and their move/resize
  // capabilities all come from `resolveColumnLayout` so a column and its track
  // cannot come apart — this shell used to derive each of them beside the
  // others.
  // Taken as a function of the order, so a move can resolve the layout for the
  // order it is actually moving against rather than the one the last render
  // happened to close over.
  const resolveLayoutForOrder = (order: string[]) =>
    resolveColumnLayout(
      createColumnRegistry(columnDefinitions),
      {
        columnOrder: order,
        columnWidths,
        hiddenColumnIds: columnDefinitions
          .filter((definition) => !visibleColumnIds.has(definition.id))
          .map((definition) => definition.id),
      },
      {
        leadingTracks: [
          GRID_TABLE_V2_FAVORITE_TRACK,
          `${artifactColumnWidth}px`,
        ],
        trailingTracks: [GRID_TABLE_V2_ADD_FIELD_TRACK],
      }
    );
  const columnLayout = resolveLayoutForOrder(columnOrder);
  const gridColumns = columnLayout.columns.map((column) => ({
    ...column,
    tooltip: column.tooltip ?? "Optional column header tool tip...",
  }));
  // Moves are expressed against the RENDERED order and merged back through
  // `toPersistedColumnOrder`, the same round trip the header's drag takes.
  // Moving against the complete order made "Move left" a no-op whenever the
  // neighbouring slot belonged to a hidden column.
  // The updater form is load-bearing: reading the rendered `columnLayout` here
  // meant two moves batched into one tick both merged against the pre-batch
  // order, and the first was dropped.
  const moveVisibleColumn = (
    columnId: string,
    placement: ColumnMovePlacement
  ) =>
    setColumnOrder((previousOrder) => {
      const previousLayout = resolveLayoutForOrder(previousOrder);
      return previousLayout.toPersistedColumnOrder(
        moveColumnPlacement(previousLayout.columnOrder, columnId, placement)
      );
    });
  const {
    clampedPage,
    displayedArtifacts,
    filterController,
    filtersActive,
    groupedArtifacts,
    hierarchyView,
    pageStart,
    matchingArtifacts,
    pagedArtifacts,
    sortedArtifacts,
    summaryMetrics,
    totalPages,
  } = useArtifactListShellDerived({
    artifacts,
    boardRootOnly,
    textFilter,
    currentUserName: currentUser.name,
    currentUserId: currentUser.id,
    buildConfiguredSummaryMetrics,
    creationKind: creationConfig.kind,
    customFieldFilters,
    customFields,
    dateDimension,
    extensionColumns,
    extensionFilters,
    favoriteArtifactIds,
    filters,
    groupBy,
    groupOrder,
    hierarchy,
    layout,
    page,
    pageSize,
    secondaryGroupBy,
    secondaryGroupOrder,
    setFilters,
    showEmptyGroups,
    showEmptySubgroups,
    sortActive,
    sortBy,
    sortDir,
  });
  const hierarchyRowForArtifact = (artifact: GenericArtifact) =>
    hierarchyView.rowByArtifactId.get(artifact.id);
  // Manual ordering is available only while automatic sorting is cleared, so a
  // user-chosen order can never be silently overwritten by a comparator.
  const manualOrderingActive = manualOrdering && !sortActive;
  const moveArtifactManually = (
    artifactId: string,
    direction: ArtifactManualMoveDirection
  ) => {
    const drop = artifactManualMoveTarget(
      hierarchyView.rows,
      artifactId,
      direction
    );
    if (!drop) {
      return;
    }
    const previousArtifacts = artifacts;
    const result = moveArtifactHierarchySubtree(
      artifacts,
      artifactId,
      drop.targetId,
      drop.placement,
      hierarchyView.maxLevels
    );
    if (result.error || !result.changed) {
      return;
    }
    setArtifacts(result.artifacts);
    hierarchyView.syncExpansionAfterMove(
      result.artifacts,
      drop.placement === "inside" ? drop.targetId : undefined
    );
    if (result.previousParentId === result.nextParentId) {
      return;
    }
    toast.success(formatArtifactHierarchyMoveMessage(result.descendantCount), {
      action: {
        label: "Undo",
        onClick: () => {
          setArtifacts(previousArtifacts);
          hierarchyView.syncExpansionAfterMove(previousArtifacts);
        },
      },
    });
  };
  const moveSelectionToProject = (destinationLabel: string) => {
    if (!projectMove) {
      return;
    }
    const previousArtifacts = artifacts;
    const result = moveArtifactHierarchySelectionToProject(
      artifacts,
      [...selectedArtifactIds],
      destinationLabel
    );
    if (result.movedArtifacts.length === 0) {
      return;
    }
    // `projectMove` carries a `currentProject`, so this list IS one project's
    // collection: what moved to another project has left it. Concatenating the
    // moved rows back on would leave them on screen with a rewritten project
    // field while the receipt says they went somewhere else.
    setArtifacts(result.remainingArtifacts);
    hierarchyView.syncExpansionAfterMove(result.remainingArtifacts);
    setSelectedArtifactIds(new Set());
    toast.success(
      `Moved ${result.movedArtifacts.length} to ${destinationLabel}`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            setArtifacts(previousArtifacts);
            hierarchyView.syncExpansionAfterMove(previousArtifacts);
          },
        },
        description: [
          result.parentClearedCount > 0
            ? `${result.parentClearedCount} promoted to root`
            : null,
          result.descendantCount > 0
            ? `${result.descendantCount} descendant${result.descendantCount === 1 ? "" : "s"} carried`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
      }
    );
  };
  const {
    handleArtifactRowClick,
    handleArtifactRowRangeDrag,
    handleArtifactRowKeyboardNavigate,
    listResultsRef,
    reconcileSelection,
    selectAllVisibleArtifacts,
    toggleArtifactSelection,
  } = useArtifactListGridSelection({
    displayedArtifacts,
    selectedArtifactIds,
    selectionAnchorId,
    setSelectedArtifactIds,
  });
  const filterViewModel = useMemo(
    () => ({
      ...buildFilterViewModel(artifacts, currentUser),
      additionalFacetGroups: buildCustomFieldFilterGroups(
        customFields,
        artifacts,
        customFieldFilters,
        setCustomFieldFilters
      ).concat(
        buildExtensionFilterGroups(
          extensionColumns,
          artifacts,
          extensionFilters,
          setExtensionFilters
        )
      ),
    }),
    [
      extensionColumns,
      artifacts,
      currentUser,
      customFieldFilters,
      customFields,
      extensionFilters,
      setCustomFieldFilters,
      setExtensionFilters,
    ]
  );
  const columnFilterGroups = useMemo(
    () =>
      buildBaseColumnFilterGroups(filterController, filterViewModel).concat(
        filterViewModel.additionalFacetGroups ?? []
      ),
    [filterController, filterViewModel]
  );
  const tagEditorContext = useMemo<TagEditorContextValue>(
    () => ({
      definitions: tagDefinitions,
      createTag: (label) =>
        setTagDefinitions((current) =>
          current.some(
            (definition) =>
              definition.label.toLowerCase() === label.toLowerCase()
          )
            ? current
            : // ISS-6385: a new tag opens on a real canonical colour, chosen
              // round-robin the way `pickDefaultColor` does server-side, not on
              // the prototype-only `"none"` the deleted third palette carried.
              // The colour picker still opens on it, so the choice is unchanged.
              [
                ...current,
                {
                  label,
                  color:
                    TAG_COLOR_PALETTE[current.length % TAG_COLOR_PALETTE.length]
                      .name,
                },
              ]
        ),
      setTagColor: (label, color) =>
        setTagDefinitions((current) =>
          current.map((definition) =>
            definition.label === label ? { ...definition, color } : definition
          )
        ),
    }),
    [tagDefinitions]
  );
  const updateArtifactTitle = (
    artifactId: string,
    nextTitle: string,
    options?: { advanceToNewRow?: boolean }
  ) => {
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      return;
    }
    const title = nextTitle.trim();
    if (title !== artifact.title) {
      const previousTitle = artifact.title;
      setArtifacts((current) =>
        current.map((item) =>
          item.id === artifactId ? { ...item, title } : item
        )
      );
      toast.success("Artifact name updated", {
        action: {
          label: "Undo",
          onClick: () =>
            setArtifacts((current) =>
              current.map((item) =>
                item.id === artifactId
                  ? { ...item, title: previousTitle }
                  : item
              )
            ),
        },
      });
    }
    if (inlineCreate?.enabled && options?.advanceToNewRow) {
      const groupKey =
        groupBy === "none"
          ? undefined
          : groupedArtifacts?.find((group) =>
              group.items.some((item) => item.id === artifactId)
            )?.key;
      setInlineDraftContext({ afterArtifactId: artifactId, groupKey });
    }
  };
  const createInlineArtifact = (
    title: string,
    groupKey?: string,
    afterArtifactId?: string
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Inline creation must atomically derive defaults from generic, custom-field, and artifact-specific view state.
  ) => {
    const previousArtifacts = artifacts;
    const inlineCustomValues: Record<
      string,
      string | number | readonly string[] | null
    > = {};
    for (const [fieldId, filter] of Object.entries({
      ...customFieldFilters,
      ...extensionFilters,
    })) {
      if (filter.selectedValues?.length === 1) {
        inlineCustomValues[fieldId] = filter.selectedValues[0] ?? null;
      }
    }
    if (groupKey && !["kind", "owner", "status", "tags"].includes(groupBy)) {
      inlineCustomValues[groupBy] = groupKey;
    }
    const groupOwner = groupBy === "owner" ? groupKey : undefined;
    const groupKind =
      groupBy === "kind" &&
      Object.values(ArtifactKind).includes(groupKey as ArtifactKind)
        ? (groupKey as ArtifactKind)
        : undefined;
    const selectedOwner =
      groupOwner ??
      (filters.owners.length === 1 ? filters.owners[0] : undefined) ??
      "Ottilie Eastwick";
    const selectedKind = groupKind ?? creationConfig.kind;
    const selectedStatus =
      (groupBy === "status" && groupKey
        ? genericArtifactStatusDefaultForRoot(selectedKind, groupKey)
        : null) ??
      (filters.statuses.length === 1 && filters.statuses[0]
        ? genericArtifactStatusForKey(selectedKind, filters.statuses[0])
        : null) ??
      genericArtifactStatusDefaultForRoot(
        selectedKind,
        ARTIFACT_STATUS_ROOT.InProgress
      ) ??
      genericArtifactStatusOptions(selectedKind)[0] ??
      ArtifactStatus.Active;
    let selectedTags: string[] = [];
    if (groupBy === "tags" && groupKey) {
      selectedTags = [groupKey];
    } else if (filters.tags.length === 1 && filters.tags[0]) {
      selectedTags = [filters.tags[0]];
    }
    const nextArtifact = buildCreatedArtifact({
      config: {
        ...creationConfig,
        kind: selectedKind,
      },
      nextNumber: artifacts.length + 1,
      values: {
        attachments: [],
        collaborators: [],
        customValues: inlineCustomValues,
        linkedArtifacts: [],
        owner: selectedOwner,
        project: creationConfig.defaultProject ?? null,
        repository: null,
        status: selectedStatus,
        summary: "",
        tags: selectedTags,
        title: title.trim(),
      },
    });
    setArtifacts((current) => {
      const sourceIndex = afterArtifactId
        ? current.findIndex((artifact) => artifact.id === afterArtifactId)
        : -1;
      if (sourceIndex < 0) {
        return [...current, nextArtifact];
      }
      return [
        ...current.slice(0, sourceIndex + 1),
        nextArtifact,
        ...current.slice(sourceIndex + 1),
      ];
    });
    setInlineDraftContext({
      afterArtifactId: nextArtifact.id,
      groupKey,
    });

    const hiddenByCurrentView =
      filters.favoritesOnly ||
      (filters.mineOnly && nextArtifact.owner !== "Ottilie Eastwick") ||
      (filters.owners.length > 0 &&
        !filters.owners.includes(nextArtifact.owner)) ||
      (filters.statuses.length > 0 &&
        !genericArtifactStatusMatchesAny(nextArtifact, filters.statuses)) ||
      (filters.kinds.length > 0 &&
        !filters.kinds.includes(nextArtifact.kind)) ||
      (filters.tags.length > 0 &&
        !filters.tags.some((tag) => nextArtifact.tags.includes(tag))) ||
      !matchesCustomFieldFilters(
        nextArtifact,
        customFields,
        customFieldFilters,
        artifacts
      ) ||
      !matchesExtensionFilters(
        nextArtifact,
        extensionColumns,
        extensionFilters
      );
    if (hiddenByCurrentView) {
      toast.success(`${nextArtifact.slug} created outside the current view`, {
        action: {
          label: "Undo",
          onClick: () => {
            setArtifactsState(previousArtifacts);
            onArtifactsChange?.(previousArtifacts);
          },
        },
      });
    }
  };
  const updateArtifact = (
    artifactId: string,
    patch: Partial<GenericArtifact>
  ) =>
    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === artifactId ? { ...artifact, ...patch } : artifact
      )
    );
  const changeArtifactStatus = (
    artifactId: string,
    status: ArtifactStatus,
    _surface?: ArtifactStatusEditSurface
  ) => {
    const previous = artifacts.find((artifact) => artifact.id === artifactId);
    if (
      !(previous && genericArtifactStatusCapability(previous).editable) ||
      previous.status === status
    ) {
      return;
    }
    updateArtifact(artifactId, { status, statusRaw: undefined });
    const statusLabel = genericArtifactStatusLabel({
      kind: previous.kind,
      status,
    });
    toast.success(`${previous.slug} moved to ${statusLabel}`, {
      action: {
        label: "Undo",
        onClick: () =>
          updateArtifact(artifactId, {
            status: previous.status,
            statusRaw: previous.statusRaw,
          }),
      },
    });
  };
  const applyGroupDrop = (
    artifactId: string,
    primaryFieldId: string,
    primaryValue: string,
    secondaryFieldId?: string,
    secondaryValue?: string,
    _placement?: "start" | "end",
    _surface?: ArtifactStatusEditSurface
  ) => {
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      return;
    }
    const next = resolveArtifactGroupDestination(
      artifact,
      primaryFieldId,
      primaryValue,
      secondaryFieldId,
      secondaryValue
    );
    if (next === null) {
      return;
    }
    setArtifacts((current) =>
      current.map((candidate) =>
        candidate.id === artifactId ? next : candidate
      )
    );
    const statusChanged =
      artifact.status !== next.status || artifact.statusRaw !== next.statusRaw;
    toast.success(
      statusChanged
        ? `${artifact.slug} moved to ${genericArtifactStatusLabel(next)}`
        : "Moved",
      {
        action: {
          label: "Undo",
          onClick: () => updateArtifact(artifactId, artifact),
        },
      }
    );
  };
  const { applyBulkAction, applyBulkStatus, bulkStatusOptions } =
    useArtifactListBulkActions({
      artifacts,
      favoriteArtifactIds,
      selectedArtifactIds,
      selectionAnchorId,
      setArtifacts,
      setFavoriteArtifactIds,
      setSelectedArtifactIds,
      setTagDefinitions,
      tagDefinitions,
    });
  const setArtifactFavorite = (artifactId: string, favorited: boolean) =>
    setFavoriteArtifactIds((current) => {
      const next = new Set(current);
      if (favorited) {
        next.add(artifactId);
      } else {
        next.delete(artifactId);
      }
      return next;
    });
  const setMobileArtifactSelected = (artifactId: string, selected: boolean) => {
    setSelectedArtifactIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(artifactId);
      } else {
        next.delete(artifactId);
      }
      return next;
    });
    selectionAnchorId.current = artifactId;
  };
  return {
    collapsedGroups,
    setCollapsedGroups,
    filters,
    setFilters,
    customFieldFilters,
    extensionFilters,
    page,
    columnOrder,
    columnWidths,
    activeSavedViewId,
    addArtifactOpen,
    addFieldOpen,
    applyBulkAction,
    applyBulkStatus,
    applyGroupDrop,
    applySavedView,
    artifactColumnWidth,
    artifacts,
    boardCreationStatus,
    bulkStatusOptions,
    changeArtifactStatus,
    clampedPage,
    columnFilterGroups,
    columnLayout,
    configuredColumns,
    creationConfig,
    createInlineArtifact,
    customFields,
    dateDimension,
    dateFilterLabel,
    displayedArtifacts,
    extensionColumns,
    favoriteArtifactIds,
    favoritesUnavailable: controlledFavoritesUnavailable,
    pendingFavoriteArtifactIds: controlledPendingFavoriteIds,
    filterController,
    filterMenuOpen,
    filtersActive,
    filterViewModel,
    gridColumns,
    groupBy,
    groupOrder,
    groupedArtifacts,
    handleArtifactRowClick,
    handleArtifactRowRangeDrag,
    handleArtifactRowKeyboardNavigate,
    hierarchyRowForArtifact,
    hierarchyView,
    inlineCreate,
    inlineDraftContext,
    layout,
    listResultsRef,
    manualOrderingActive,
    matchingArtifacts,
    moveArtifactManually,
    moveSelectionToProject,
    moveVisibleColumn,
    onArtifactsChange,
    onOpenArtifact,
    onOpenArtifactHref,
    openCreatedArtifactAfterCreate,
    pageSize,
    pageStart,
    pagedArtifacts,
    projectMove,
    reconcileSelection,
    saveCurrentView,
    savedViews,
    secondaryGroupBy,
    secondaryGroupOrder,
    selectedArtifactIds,
    selectionAnchorId,
    selectionNoun,
    setAddArtifactOpen,
    setAddFieldOpen,
    setArtifactFavorite,
    selectAllVisibleArtifacts,
    setArtifactListLayout,
    setArtifactColumnWidth,
    setArtifacts,
    setArtifactsState,
    setBoardCreationStatus,
    setColumnOrder,
    setColumnWidths,
    setCustomFields,
    setCustomFieldFilters,
    setExtensionFilters,
    setFilterMenuOpen,
    setGroupBy,
    setGroupOrder,
    setInlineDraftContext,
    setMobileArtifactSelected,
    setPage,
    setPageSize,
    setSecondaryGroupBy,
    setSecondaryGroupOrder,
    setSelectedArtifactIds,
    setShowEmptyGroups,
    setShowEmptySubgroups,
    setSortActive,
    setSortBy,
    setSortDir,
    setVisibleColumnIds,
    setVisibleMetricKeys,
    showAddArtifactButton,
    showAddFieldButton,
    showBoardAddButton,
    showEmptyGroups,
    showEmptySubgroups,
    showSummaryCards,
    sortActive,
    sortBy,
    sortDir,
    sortedArtifacts,
    statusBoard,
    summaryMetricDefinitions,
    summaryMetrics,
    tagDefinitions,
    toggleArtifactSelection,
    tagEditorContext,
    totalPages,
    updateArtifact,
    updateArtifactTitle,
    variant,
    visibleColumnIds,
    visibleMetricKeys,
  };
}
