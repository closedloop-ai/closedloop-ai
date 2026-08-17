// biome-ignore-all lint/style/noExcessiveLinesPerFile: This shared prototype shell remains co-located while its public API is being validated.
"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  ColumnMoveDirection,
  moveColumnByDirection,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { cn } from "@repo/design-system/lib/utils";
import { Columns3Icon, ListIcon, PlusIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../mock";
import { buildBaseColumnFilterGroups } from "./artifact-column-filters";
import {
  buildCreatedArtifact,
  defaultArtifactCreationConfig,
} from "./artifact-creation";
import { AddArtifactDialog } from "./artifact-creation-dialog";
import {
  ArtifactTablePagination,
  EditableArtifactLead,
  GenericArtifactCard,
  renderGenericArtifactCell,
} from "./artifact-list-cells";
import {
  ArtifactBulkActionBar,
  ArtifactGroupMenu,
  ArtifactOptionsMenu,
  ArtifactRowUtilities,
  ArtifactSavedViewsMenu,
  ArtifactSortMenu,
  ArtifactViewMenu,
  applyArtifactBulkMutation,
} from "./artifact-list-controls";
import { genericArtifactSortValue } from "./artifact-list-custom-cells";
import {
  type ArtifactBulkAction,
  type ArtifactFilters,
  type ArtifactGroupOrder,
  type ArtifactListLayout,
  buildCustomFieldFilterGroups,
  buildExtensionFilterGroups,
  buildFilterController,
  buildFilterViewModel,
  buildSummaryMetrics,
  type CustomFieldFilter,
  DATE_RANGES,
  defaultRelatedSessionsForArtifact,
  EDITABLE_OWNERS,
  type GenericArtifactListShellProps,
  genericArtifactColumns,
  genericSummaryMetricDefinitions,
  INITIAL_TAG_DEFINITIONS,
  initialArtifactFilters,
  isCustomFieldGroupable,
  isCustomFieldSortable,
  matchesCustomFieldFilters,
  matchesExtensionFilters,
  type PAGE_SIZES,
  RELATED_SESSIONS_COLUMN_ID,
  type TagDefinition,
  TagEditorContext,
  type TagEditorContextValue,
  updatedPresetMinutes,
} from "./artifact-list-model";
import { useArtifactListRouteState } from "./artifact-list-route-state";
import {
  buildInitialSavedViews,
  type SavedViewRecord,
} from "./artifact-saved-views";
import { ArtifactStatusBoard } from "./artifact-status-board";
import {
  type CustomFieldDefinition,
  CustomFieldDialog,
} from "./custom-field-dialog";
import { ActiveFiltersBar } from "./experimental/active-filters-bar";
import {
  FilterGroupContent,
  FilterPopover,
} from "./experimental/filter-popover";
import { GridTable, type GridTableGroup } from "./experimental/grid-table";
import { MetricCard } from "./experimental/metric-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./experimental/tooltip";
import { GenericArtifactDetailShell as RedesignedGenericArtifactDetailShell } from "./generic-artifact-detail-shell";
import { buildRelatedSessionsColumn } from "./related-sessions-column";

export type {
  ArtifactListColumnExtension,
  ArtifactListSummaryMetric,
} from "./artifact-list-model";
export type {
  ArtifactCanvasState,
  ArtifactShellAction,
  ArtifactShellPresentation,
  DetailTab,
  GenericArtifactDetailShellProps,
} from "./generic-artifact-detail-shell";

export const GenericArtifactDetailShell = RedesignedGenericArtifactDetailShell;

function summaryComparisonLabel(dateRange: string) {
  if (dateRange === "all") {
    return "vs. prior period";
  }
  return `vs. prior ${dateRange.slice(0, -1)} days`;
}

function orderGroupEntries<T extends { label: string }>(
  entries: readonly (readonly [string, T])[],
  order: ArtifactGroupOrder,
  customOrder: readonly string[]
) {
  return [...entries].sort(([leftKey, left], [rightKey, right]) => {
    if (order === "asc" || order === "desc") {
      const comparison = left.label.localeCompare(right.label, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return order === "asc" ? comparison : -comparison;
    }
    const leftIndex = customOrder.indexOf(leftKey);
    const rightIndex = customOrder.indexOf(rightKey);
    if (leftIndex === -1 && rightIndex === -1) {
      return 0;
    }
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

type ArtifactGroupBucket = {
  items: GenericArtifact[];
  label: string;
};

type ArtifactGroupDefinition = {
  key: string;
  label: string;
};

function artifactGroupDefinitions(
  fieldId: string,
  statuses: readonly { label?: string; status: string }[]
): ArtifactGroupDefinition[] {
  if (fieldId === "status") {
    return statuses.map((definition) => ({
      key: definition.status,
      label: definition.label ?? definition.status,
    }));
  }
  if (fieldId === "owner") {
    return [
      ...EDITABLE_OWNERS.map((owner) => ({
        key: owner.name,
        label: owner.name,
      })),
      { key: "No value", label: "Unassigned" },
    ];
  }
  return [];
}

function buildArtifactSubgroups({
  artifacts,
  definitions,
  descriptorForArtifact,
  order,
  showEmpty,
}: {
  artifacts: readonly GenericArtifact[];
  definitions: readonly ArtifactGroupDefinition[];
  descriptorForArtifact: (artifact: GenericArtifact) => ArtifactGroupDefinition;
  order: ArtifactGroupOrder;
  showEmpty: boolean;
}): GridTableGroup<GenericArtifact>[] {
  const subgroups = new Map<string, ArtifactGroupBucket>();
  for (const artifact of artifacts) {
    const descriptor = descriptorForArtifact(artifact);
    const current = subgroups.get(descriptor.key);
    subgroups.set(descriptor.key, {
      items: [...(current?.items ?? []), artifact],
      label: descriptor.label,
    });
  }
  if (showEmpty) {
    for (const definition of definitions) {
      if (!subgroups.has(definition.key)) {
        subgroups.set(definition.key, {
          items: [],
          label: definition.label,
        });
      }
    }
  }
  return orderGroupEntries(
    [...subgroups.entries()].filter(
      ([, subgroup]) => showEmpty || subgroup.items.length > 0
    ),
    order,
    definitions.map((definition) => definition.key)
  ).map(([key, subgroup]) => ({
    items: subgroup.items,
    key,
    label: subgroup.label,
  }));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This shared prototype shell intentionally coordinates the table's interoperable view state in one place while its API is being validated.
export function GenericArtifactListShell({
  addArtifactOpen: controlledAddArtifactOpen,
  additionalColumns = [],
  artifacts: initialArtifacts = genericArtifacts,
  buildSummaryMetrics: buildConfiguredSummaryMetrics,
  creationConfig = defaultArtifactCreationConfig,
  dateFilterLabel = "Artifact updated within time period",
  defaultVisibleColumnIds,
  excludedColumnIds = [],
  inlineCreate,
  legacyColumnAliases,
  legacyMetricAliases,
  onAddArtifactOpenChange,
  onArtifactsChange,
  onOpenArtifact,
  onOpenArtifactHref,
  relatedSessionsForArtifact = defaultRelatedSessionsForArtifact,
  selectionNoun = { plural: "artifacts", singular: "artifact" },
  statusBoard = {
    editable: true,
    statuses: [
      { status: ArtifactStatus.Draft },
      { status: ArtifactStatus.Active },
      { status: ArtifactStatus.InReview },
      { status: ArtifactStatus.Approved },
      { status: ArtifactStatus.Completed },
      { status: ArtifactStatus.Archived },
    ],
  },
  showAddArtifactButton = true,
  showBoardAddButton = showAddArtifactButton,
  showAddFieldButton = true,
  showDateRangeControl = true,
  showSummaryCards = true,
  variant = "page",
  summaryMetricDefinitions = genericSummaryMetricDefinitions,
}: GenericArtifactListShellProps) {
  const [artifacts, setArtifactsState] = useState<GenericArtifact[]>([
    ...initialArtifacts,
  ]);
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
  const [dateRange, setDateRange] = useState("30d");
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [sortActive, setSortActive] = useState(false);
  const [groupBy, setGroupBy] = useState("none");
  const [groupOrder, setGroupOrder] = useState<ArtifactGroupOrder>("custom");
  const [secondaryGroupBy, setSecondaryGroupBy] = useState("none");
  const [secondaryGroupOrder, setSecondaryGroupOrder] =
    useState<ArtifactGroupOrder>("asc");
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);
  const [showEmptySubgroups, setShowEmptySubgroups] = useState(true);
  const [groupValueOverrides, setGroupValueOverrides] = useState<
    Record<string, Record<string, string>>
  >({});
  const [layout, setLayout] = useState<ArtifactListLayout>("list");
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<Set<string>>(
    () => new Set()
  );
  const selectionAnchorId = useRef<string | null>(null);
  const [favoriteArtifactIds, setFavoriteArtifactIds] = useState<Set<string>>(
    () => new Set(["artifact-1"])
  );
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [inlineDraftContext, setInlineDraftContext] = useState<{
    afterArtifactId?: string;
    groupKey?: string;
  } | null>(null);
  const [internalAddArtifactOpen, setInternalAddArtifactOpen] = useState(false);
  const [boardCreationStatus, setBoardCreationStatus] =
    useState<ArtifactStatus | null>(null);
  const addArtifactOpen = controlledAddArtifactOpen ?? internalAddArtifactOpen;
  const setAddArtifactOpen =
    onAddArtifactOpenChange ?? setInternalAddArtifactOpen;
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [tagDefinitions, setTagDefinitions] = useState<TagDefinition[]>(
    INITIAL_TAG_DEFINITIONS
  );
  const [customFieldFilters, setCustomFieldFilters] = useState<
    Record<string, CustomFieldFilter>
  >({});
  const [extensionFilters, setExtensionFilters] = useState<
    Record<string, CustomFieldFilter>
  >({});
  const relatedSessionsColumn = buildRelatedSessionsColumn(
    relatedSessionsForArtifact,
    onOpenArtifactHref
  );
  const extensionColumns = excludedColumnIds.includes(
    RELATED_SESSIONS_COLUMN_ID
  )
    ? additionalColumns
    : [relatedSessionsColumn, ...additionalColumns];
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
  ].filter((column) => !excludedColumnIds.includes(column.id));
  const [columnOrder, setColumnOrder] = useState<string[]>(() =>
    configuredColumns.map((column) => column.id)
  );
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      configuredColumns.map((column) => [
        column.id,
        Number.parseInt(column.width, 10),
      ])
    )
  );
  const [artifactColumnWidth, setArtifactColumnWidth] = useState(280);
  const [filters, setFilters] = useState<ArtifactFilters>(
    initialArtifactFilters
  );
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [visibleMetricKeys, setVisibleMetricKeys] = useState<Set<string>>(
    () => new Set(summaryMetricDefinitions.map((metric) => metric.key))
  );
  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string>>(
    () =>
      new Set(
        defaultVisibleColumnIds ?? configuredColumns.map((column) => column.id)
      )
  );
  const [savedViews, setSavedViews] = useState<SavedViewRecord[]>(() =>
    buildInitialSavedViews({
      columnIds: [...visibleColumnIds],
      initialFilters: initialArtifactFilters,
      metricKeys: summaryMetricDefinitions.map((metric) => metric.key),
      statuses: {
        active: ArtifactStatus.Active,
        inReview: ArtifactStatus.InReview,
        needsYou: ArtifactStatus.NeedsYou,
      },
    })
  );
  const [activeSavedViewId, setActiveSavedViewId] = useState("default");
  const applySavedView = (viewId: string) => {
    const view = savedViews.find((candidate) => candidate.id === viewId);
    if (!view) {
      return;
    }
    setDateRange(view.state.dateRange);
    setFilters(view.state.filters);
    setCustomFieldFilters({});
    setExtensionFilters({});
    setGroupBy(view.state.groupBy);
    setGroupOrder(view.state.groupOrder);
    setSecondaryGroupBy(view.state.secondaryGroupBy);
    setSecondaryGroupOrder(view.state.secondaryGroupOrder);
    setShowEmptyGroups(view.state.showEmptyGroups);
    setShowEmptySubgroups(view.state.showEmptySubgroups);
    setLayout(view.state.layout);
    setSortActive(view.state.sortActive);
    setSortBy(view.state.sortBy);
    setSortDir(view.state.sortDir);
    setVisibleColumnIds(new Set(view.state.columnIds));
    setVisibleMetricKeys(new Set(view.state.metricKeys));
    setPage(0);
    setActiveSavedViewId(viewId);
  };
  const saveCurrentView = (name: string) => {
    const view: SavedViewRecord = {
      id: `personal-${Date.now()}`,
      name,
      scope: "personal",
      state: {
        columnIds: [...visibleColumnIds],
        dateRange,
        filters,
        groupBy,
        groupOrder,
        secondaryGroupBy,
        secondaryGroupOrder,
        showEmptyGroups,
        showEmptySubgroups,
        layout,
        metricKeys: [...visibleMetricKeys],
        sortActive,
        sortBy,
        sortDir,
      },
    };
    setSavedViews((current) => [...current, view]);
    setActiveSavedViewId(view.id);
    toast.success(`Saved view “${name}”`);
  };
  useArtifactListRouteState({
    activeSavedViewId,
    customFieldFilters,
    dateRange,
    extensionFilters,
    filters,
    groupBy,
    groupOrder,
    secondaryGroupBy,
    secondaryGroupOrder,
    showEmptyGroups,
    showEmptySubgroups,
    layout,
    legacyColumnAliases,
    legacyMetricAliases,
    setActiveSavedViewId,
    setCustomFieldFilters,
    setDateRange,
    setExtensionFilters,
    setFilters,
    setGroupBy,
    setGroupOrder,
    setSecondaryGroupBy,
    setSecondaryGroupOrder,
    setShowEmptyGroups,
    setShowEmptySubgroups,
    setLayout,
    setSortActive,
    setSortBy,
    setSortDir,
    setVisibleColumnIds,
    setVisibleMetricKeys,
    sortActive,
    sortBy,
    sortDir,
    visibleColumnIds,
    visibleMetricKeys,
  });
  const setArtifactListLayout = (nextLayout: ArtifactListLayout) => {
    setLayout(nextLayout);
    if (nextLayout === "board" && groupBy === "none") {
      setGroupBy("status");
    }
  };
  useEffect(() => {
    if (groupBy === secondaryGroupBy && groupBy !== "none") {
      setSecondaryGroupBy("none");
    }
  }, [groupBy, secondaryGroupBy]);
  const visibleColumns = [
    ...configuredColumns,
    ...customFields.map((field) => ({
      filterable: true,
      groupable: isCustomFieldGroupable(field),
      id: field.id,
      label: field.label,
      sortable: isCustomFieldSortable(field),
      width: "180px",
    })),
  ].filter((column) => visibleColumnIds.has(column.id));
  const orderedVisibleColumns = orderColumns(visibleColumns, columnOrder);
  const moveVisibleColumn = (
    columnId: string,
    direction: "start" | "left" | "right" | "end"
  ) =>
    setColumnOrder((current) => {
      if (direction === "left" || direction === "right") {
        return moveColumnByDirection(
          current,
          columnId,
          direction === "left"
            ? ColumnMoveDirection.Left
            : ColumnMoveDirection.Right
        );
      }
      const withoutColumn = current.filter((id) => id !== columnId);
      return direction === "start"
        ? [columnId, ...withoutColumn]
        : [...withoutColumn, columnId];
    });
  const filteredArtifacts = useMemo(() => {
    const rangeDays =
      dateRange === "all"
        ? Number.POSITIVE_INFINITY
        : Number(dateRange.slice(0, -1));
    const updatedMinutes = updatedPresetMinutes(filters.updatedPreset);
    return artifacts.filter(
      (artifact) =>
        artifact.updatedAgoMinutes <= rangeDays * 24 * 60 &&
        (!filters.mineOnly || artifact.owner === "Andrew Eye") &&
        (!filters.favoritesOnly || favoriteArtifactIds.has(artifact.id)) &&
        (filters.owners.length === 0 ||
          filters.owners.includes(artifact.owner)) &&
        (filters.statuses.length === 0 ||
          filters.statuses.includes(artifact.status)) &&
        (filters.kinds.length === 0 || filters.kinds.includes(artifact.kind)) &&
        (filters.tags.length === 0 ||
          filters.tags.some((tag) => artifact.tags.includes(tag))) &&
        (updatedMinutes === null ||
          artifact.updatedAgoMinutes <= updatedMinutes) &&
        matchesCustomFieldFilters(artifact, customFields, customFieldFilters) &&
        matchesExtensionFilters(artifact, extensionColumns, extensionFilters)
    );
  }, [
    extensionColumns,
    artifacts,
    customFieldFilters,
    customFields,
    dateRange,
    extensionFilters,
    favoriteArtifactIds,
    filters,
  ]);
  const summaryMetrics = useMemo(
    () =>
      buildConfiguredSummaryMetrics?.(filteredArtifacts) ??
      buildSummaryMetrics(filteredArtifacts),
    [buildConfiguredSummaryMetrics, filteredArtifacts]
  );
  const sortedArtifacts = useMemo(() => {
    if (!sortActive) {
      return filteredArtifacts;
    }
    return [...filteredArtifacts].sort((left, right) => {
      const extension = extensionColumns.find((column) => column.id === sortBy);
      const leftValue =
        extension?.sortValue?.(left) ??
        genericArtifactSortValue(left, sortBy, customFields);
      const rightValue =
        extension?.sortValue?.(right) ??
        genericArtifactSortValue(right, sortBy, customFields);
      const comparison =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
      return comparison * (sortDir === "asc" ? 1 : -1);
    });
  }, [
    extensionColumns,
    customFields,
    filteredArtifacts,
    sortActive,
    sortBy,
    sortDir,
  ]);
  const groupValueForArtifact = useCallback(
    (artifact: GenericArtifact, fieldId: string) => {
      const override = groupValueOverrides[artifact.id]?.[fieldId];
      if (override !== undefined) {
        return override;
      }
      const extension = extensionColumns.find(
        (column) => column.id === fieldId
      );
      const raw =
        extension?.groupValue?.(artifact) ??
        genericArtifactSortValue(artifact, fieldId, customFields);
      const value = String(raw).trim();
      return value || "No value";
    },
    [customFields, extensionColumns, groupValueOverrides]
  );
  const groupDescriptor = useCallback(
    (fieldId: string, value: string) => {
      if (fieldId === "status") {
        const definition = statusBoard.statuses.find(
          (candidate) => candidate.status === value
        );
        return {
          key: value,
          label: definition?.label ?? value,
        };
      }
      return { key: value, label: value };
    },
    [statusBoard.statuses]
  );
  const groupedArtifacts = useMemo<
    GridTableGroup<GenericArtifact>[] | undefined
  >(() => {
    if (groupBy === "none") {
      return undefined;
    }
    const groups = new Map<
      string,
      { items: GenericArtifact[]; label: string }
    >();
    for (const artifact of sortedArtifacts) {
      const descriptor = groupDescriptor(
        groupBy,
        groupValueForArtifact(artifact, groupBy)
      );
      const current = groups.get(descriptor.key);
      groups.set(descriptor.key, {
        items: [...(current?.items ?? []), artifact],
        label: descriptor.label,
      });
    }
    const groupDefinitions = artifactGroupDefinitions(
      groupBy,
      statusBoard.statuses
    );
    if (showEmptyGroups) {
      for (const definition of groupDefinitions) {
        if (!groups.has(definition.key)) {
          groups.set(definition.key, { items: [], label: definition.label });
        }
      }
    }
    const customGroupOrder = groupDefinitions.map(
      (definition) => definition.key
    );
    const orderedEntries = orderGroupEntries(
      [...groups.entries()].filter(
        ([, group]) => showEmptyGroups || group.items.length > 0
      ),
      groupOrder,
      customGroupOrder
    );
    return orderedEntries.map(([key, group]) => ({
      key,
      label: group.label,
      items: group.items,
      subgroups:
        secondaryGroupBy === "none"
          ? undefined
          : buildArtifactSubgroups({
              artifacts: group.items,
              definitions: artifactGroupDefinitions(
                secondaryGroupBy,
                statusBoard.statuses
              ),
              descriptorForArtifact: (artifact) =>
                groupDescriptor(
                  secondaryGroupBy,
                  groupValueForArtifact(artifact, secondaryGroupBy)
                ),
              order: secondaryGroupOrder,
              showEmpty: showEmptySubgroups,
            }),
    }));
  }, [
    groupBy,
    groupDescriptor,
    groupOrder,
    groupValueForArtifact,
    secondaryGroupBy,
    secondaryGroupOrder,
    showEmptyGroups,
    showEmptySubgroups,
    sortedArtifacts,
    statusBoard.statuses,
  ]);
  const totalPages = Math.max(1, Math.ceil(sortedArtifacts.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageStart = clampedPage * pageSize;
  const pagedArtifacts = sortedArtifacts.slice(pageStart, pageStart + pageSize);
  const displayedArtifacts =
    groupBy === "none" ? pagedArtifacts : sortedArtifacts;
  const handleArtifactSelection = (
    artifact: GenericArtifact,
    event: Pick<
      MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>,
      "ctrlKey" | "metaKey" | "shiftKey"
    >
  ) => {
    const currentIndex = displayedArtifacts.findIndex(
      (item) => item.id === artifact.id
    );
    const anchorIndex = displayedArtifacts.findIndex(
      (item) => item.id === selectionAnchorId.current
    );

    if (event.shiftKey && anchorIndex >= 0 && currentIndex >= 0) {
      const rangeStart = Math.min(anchorIndex, currentIndex);
      const rangeEnd = Math.max(anchorIndex, currentIndex);
      setSelectedArtifactIds(
        new Set(
          displayedArtifacts
            .slice(rangeStart, rangeEnd + 1)
            .map((item) => item.id)
        )
      );
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedArtifactIds((current) => {
        const next = new Set(current);
        if (next.has(artifact.id)) {
          next.delete(artifact.id);
        } else {
          next.add(artifact.id);
        }
        return next;
      });
    } else {
      setSelectedArtifactIds(new Set([artifact.id]));
    }
    selectionAnchorId.current = artifact.id;
  };
  const handleArtifactRowClick = (
    artifact: GenericArtifact,
    event: MouseEvent<HTMLDivElement>
  ) => handleArtifactSelection(artifact, event);
  const handleArtifactRowKeyboardNavigate = (
    artifact: GenericArtifact,
    event: KeyboardEvent<HTMLDivElement>
  ) => handleArtifactSelection(artifact, event);
  const filterController = useMemo(
    () => buildFilterController(filters, setFilters),
    [filters]
  );
  const filterViewModel = useMemo(
    () => ({
      ...buildFilterViewModel(artifacts),
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
      customFieldFilters,
      customFields,
      extensionFilters,
    ]
  );
  const filtersActive =
    filterController.activeChips.length > 0 ||
    Object.values(customFieldFilters).some(
      (filter) =>
        !!filter.selectedValues?.length ||
        filter.min !== undefined ||
        filter.max !== undefined
    ) ||
    Object.values(extensionFilters).some(
      (filter) =>
        !!filter.selectedValues?.length ||
        filter.min !== undefined ||
        filter.max !== undefined
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
            : [...current, { label, color: "none" }]
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
  const gridTemplateColumns = [
    "36px",
    `${artifactColumnWidth}px`,
    ...orderedVisibleColumns.map(
      (column) =>
        `${columnWidths[column.id] ?? Number.parseInt(column.width, 10)}px`
    ),
    "40px",
  ].join(" ");
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
    const groupStatus = Object.values(ArtifactStatus).find(
      (status) => groupBy === "status" && status === groupKey
    );
    const groupOwner = groupBy === "owner" ? groupKey : undefined;
    const groupKind =
      groupBy === "kind" &&
      Object.values(ArtifactKind).includes(groupKey as ArtifactKind)
        ? (groupKey as ArtifactKind)
        : undefined;
    const selectedOwner =
      groupOwner ??
      (filters.owners.length === 1 ? filters.owners[0] : undefined) ??
      "Andrew Eye";
    const selectedStatus =
      groupStatus ??
      (filters.statuses.length === 1 ? filters.statuses[0] : undefined) ??
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
        kind: groupKind ?? creationConfig.kind,
      },
      nextNumber: artifacts.length + 1,
      values: {
        collaborators: [],
        customValues: inlineCustomValues,
        linkedArtifacts: [],
        owner: selectedOwner,
        project: null,
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
      (filters.mineOnly && nextArtifact.owner !== "Andrew Eye") ||
      (filters.owners.length > 0 &&
        !filters.owners.includes(nextArtifact.owner)) ||
      (filters.statuses.length > 0 &&
        !filters.statuses.includes(nextArtifact.status)) ||
      (filters.kinds.length > 0 &&
        !filters.kinds.includes(nextArtifact.kind)) ||
      (filters.tags.length > 0 &&
        !filters.tags.some((tag) => nextArtifact.tags.includes(tag))) ||
      !matchesCustomFieldFilters(
        nextArtifact,
        customFields,
        customFieldFilters
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
  const applyGroupValueChange = (
    artifactId: string,
    fieldId: string,
    value: string
  ) => {
    if (fieldId === "status") {
      const status = Object.values(ArtifactStatus).find(
        (candidate) => candidate === value
      );
      if (status) {
        updateArtifact(artifactId, { status });
      }
      return;
    }
    if (fieldId === "owner") {
      const owner = EDITABLE_OWNERS.find(
        (candidate) => candidate.name === value
      );
      if (owner) {
        updateArtifact(artifactId, {
          owner: owner.name,
          ownerInitials: owner.initials,
        });
      }
      return;
    }
    setGroupValueOverrides((current) => ({
      ...current,
      [artifactId]: {
        ...current[artifactId],
        [fieldId]: value,
      },
    }));
    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === artifactId
          ? {
              ...artifact,
              creationValues: {
                ...artifact.creationValues,
                [fieldId]: value === "No value" ? null : value,
              },
            }
          : artifact
      )
    );
  };
  const applyBulkAction = (action: ArtifactBulkAction, value?: string) => {
    const selectedIds = new Set(selectedArtifactIds);
    const previousArtifacts = artifacts;
    const previousFavorites = new Set(favoriteArtifactIds);
    const previousTagDefinitions = tagDefinitions;
    const count = selectedIds.size;
    const actionLabel = {
      "add-tag": "Tag added",
      "add-to-project": "Added to project",
      "assign-owner": "Owner assigned",
      favorite: "Added to favorites",
    }[action];

    if (action === "favorite") {
      setFavoriteArtifactIds((current) => {
        const next = new Set(current);
        for (const id of selectedIds) {
          next.add(id);
        }
        return next;
      });
    } else {
      setArtifacts((current) =>
        current.map((artifact) =>
          selectedIds.has(artifact.id)
            ? applyArtifactBulkMutation(artifact, action, value)
            : artifact
        )
      );
      if (action === "add-tag") {
        setTagDefinitions((current) =>
          !value || current.some((tag) => tag.label === value)
            ? current
            : [...current, { color: "blue", label: value }]
        );
      }
    }

    setSelectedArtifactIds(new Set());
    selectionAnchorId.current = null;
    toast.success(
      `${actionLabel} for ${count} artifact${count === 1 ? "" : "s"}`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            setArtifacts(previousArtifacts);
            setFavoriteArtifactIds(previousFavorites);
            setTagDefinitions(previousTagDefinitions);
          },
        },
      }
    );
  };
  const visibleColumnWidths = Object.fromEntries(
    orderedVisibleColumns.map((column) => [
      column.id,
      columnWidths[column.id] ?? Number.parseInt(column.width, 10),
    ])
  );
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

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        variant === "page" ? "overflow-hidden max-md:pb-14" : "overflow-visible"
      )}
    >
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {showDateRangeControl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroup
                  aria-label={dateFilterLabel}
                  onValueChange={(value) => {
                    if (value) {
                      setDateRange(value);
                      setPage(0);
                    }
                  }}
                  type="single"
                  value={dateRange}
                  variant="outline"
                >
                  {DATE_RANGES.map((range) => (
                    <ToggleGroupItem
                      aria-label={range.label}
                      className="px-2.5 data-[variant=outline]:h-[26px]"
                      key={range.value}
                      value={range.value}
                    >
                      {range.value === "all" ? "All" : range.value}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </TooltipTrigger>
              <TooltipContent>{dateFilterLabel}</TooltipContent>
            </Tooltip>
          ) : null}
          <FilterPopover
            controller={filterController}
            onClear={() => {
              filterController.clearAllFilters();
              setCustomFieldFilters({});
              setExtensionFilters({});
            }}
            onOpenChange={setFilterMenuOpen}
            open={filterMenuOpen}
            viewModel={filterViewModel}
          />
          <div className="ml-auto hidden flex-wrap items-center justify-end gap-2 md:flex">
            {variant === "page" ? (
              <ToggleGroup
                aria-label="Artifact layout"
                onValueChange={(value) => {
                  if (value === "list" || value === "board") {
                    setArtifactListLayout(value);
                  }
                }}
                type="single"
                value={layout}
                variant="outline"
              >
                <ToggleGroupItem
                  aria-label="List view"
                  className="px-2 data-[variant=outline]:h-[26px]"
                  value="list"
                >
                  <ListIcon />
                  List
                </ToggleGroupItem>
                <ToggleGroupItem
                  aria-label="Board view"
                  className="px-2 data-[variant=outline]:h-[26px]"
                  value="board"
                >
                  <Columns3Icon />
                  Board
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            <ArtifactSortMenu
              active={sortActive}
              columns={configuredColumns}
              customFields={customFields}
              onClear={() => {
                setSortActive(false);
                setSortBy("name");
                setSortDir("asc");
              }}
              onSort={(column, direction) => {
                setSortActive(true);
                setSortBy(column);
                setSortDir(direction);
              }}
              sortBy={sortBy}
            />
            <ArtifactGroupMenu
              columns={configuredColumns}
              customFields={customFields}
              groupBy={groupBy}
              groupOrder={groupOrder}
              secondaryGroupBy={secondaryGroupBy}
              secondaryGroupOrder={secondaryGroupOrder}
              setGroupBy={setGroupBy}
              setGroupOrder={setGroupOrder}
              setSecondaryGroupBy={setSecondaryGroupBy}
              setSecondaryGroupOrder={setSecondaryGroupOrder}
              setShowEmptyGroups={setShowEmptyGroups}
              setShowEmptySubgroups={setShowEmptySubgroups}
              showEmptyGroups={showEmptyGroups}
              showEmptySubgroups={showEmptySubgroups}
            />
            <ArtifactOptionsMenu
              columnIds={visibleColumnIds}
              columns={configuredColumns}
              customFields={customFields}
              metricDefinitions={summaryMetricDefinitions}
              metricKeys={visibleMetricKeys}
              setColumnIds={setVisibleColumnIds}
              setMetricKeys={setVisibleMetricKeys}
            />
            <ArtifactSavedViewsMenu
              activeViewId={activeSavedViewId}
              onApply={applySavedView}
              onSave={saveCurrentView}
              views={savedViews}
            />
            {showAddFieldButton ? (
              <Button
                onClick={() => setAddFieldOpen(true)}
                size="sm"
                variant="outline"
              >
                <PlusIcon />
                Add field
              </Button>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-2 md:hidden">
            {variant === "page" ? (
              <ToggleGroup
                aria-label="Artifact layout"
                onValueChange={(value) => {
                  if (value === "list" || value === "board") {
                    setArtifactListLayout(value);
                  }
                }}
                type="single"
                value={layout}
                variant="outline"
              >
                <ToggleGroupItem aria-label="List view" value="list">
                  <ListIcon />
                </ToggleGroupItem>
                <ToggleGroupItem aria-label="Board view" value="board">
                  <Columns3Icon />
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            <ArtifactSavedViewsMenu
              activeViewId={activeSavedViewId}
              onApply={applySavedView}
              onSave={saveCurrentView}
              views={savedViews}
            />
            <ArtifactViewMenu
              columnIds={visibleColumnIds}
              columns={configuredColumns}
              customFields={customFields}
              groupBy={groupBy}
              metricDefinitions={summaryMetricDefinitions}
              metricKeys={visibleMetricKeys}
              onAddField={() => setAddFieldOpen(true)}
              onClearSort={() => {
                setSortActive(false);
                setSortBy("name");
                setSortDir("asc");
              }}
              onSort={(column) => {
                setSortActive(true);
                setSortBy(column);
                setSortDir("asc");
              }}
              secondaryGroupBy={secondaryGroupBy}
              setColumnIds={setVisibleColumnIds}
              setGroupBy={setGroupBy}
              setMetricKeys={setVisibleMetricKeys}
              setSecondaryGroupBy={setSecondaryGroupBy}
              showAddFieldButton={showAddFieldButton}
              sortBy={sortActive ? sortBy : "none"}
            />
          </div>
          {showAddArtifactButton ? (
            <Button onClick={() => setAddArtifactOpen(true)} size="sm">
              <PlusIcon />
              Add artifact
            </Button>
          ) : null}
        </div>
        {filtersActive ? (
          <div className="-mx-4 pt-2">
            <ActiveFiltersBar
              controller={filterController}
              viewModel={filterViewModel}
            />
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1",
          variant === "page" ? "overflow-auto" : "overflow-visible"
        )}
      >
        {showSummaryCards ? (
          <div className="sticky left-0 px-4 pt-4 pb-3">
            <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 md:snap-none">
              {summaryMetrics
                .filter((metric) => visibleMetricKeys.has(metric.key))
                .map((metric) => (
                  <MetricCard
                    className="shrink-0 basis-[calc(100%_-_2.5rem)] snap-start md:min-w-44 md:flex-1 md:basis-auto"
                    delta={metric.delta}
                    deltaLabel={summaryComparisonLabel(dateRange)}
                    info={metric.info}
                    key={metric.key}
                    label={metric.label}
                    value={metric.value}
                  />
                ))}
            </div>
          </div>
        ) : null}

        <TagEditorContext.Provider value={tagEditorContext}>
          {layout === "board" ? (
            <ArtifactStatusBoard
              config={statusBoard}
              groupBy={groupBy}
              groups={groupedArtifacts ?? []}
              noun={selectionNoun}
              onAdd={
                showBoardAddButton && statusBoard.editable
                  ? (status) => {
                      setBoardCreationStatus(status);
                      setAddArtifactOpen(true);
                    }
                  : undefined
              }
              onGroupChange={applyGroupValueChange}
              onOpen={onOpenArtifact}
              onOpenHref={onOpenArtifactHref}
              onStatusChange={(artifactId, status) => {
                const previous = artifacts.find(
                  (artifact) => artifact.id === artifactId
                );
                if (!previous || previous.status === status) {
                  return;
                }
                updateArtifact(artifactId, { status });
                toast.success(`${previous.slug} moved to ${status}`, {
                  action: {
                    label: "Undo",
                    onClick: () =>
                      updateArtifact(artifactId, { status: previous.status }),
                  },
                });
              }}
              secondaryGroupBy={secondaryGroupBy}
            />
          ) : (
            <GridTable
              cardRender={(artifact, columns) => (
                <GenericArtifactCard
                  additionalColumns={extensionColumns}
                  artifact={artifact}
                  columns={columns}
                  customFields={customFields}
                  favorited={favoriteArtifactIds.has(artifact.id)}
                  onFavoriteChange={(favorited) =>
                    setArtifactFavorite(artifact.id, favorited)
                  }
                  onOpenArtifact={onOpenArtifact}
                  onSelectedChange={(selected) =>
                    setMobileArtifactSelected(artifact.id, selected)
                  }
                  selected={selectedArtifactIds.has(artifact.id)}
                />
              )}
              columnOrder={columnOrder}
              columns={visibleColumns.map(({ width, ...column }) => ({
                ...column,
                tooltip:
                  ("tooltip" in column ? column.tooltip : undefined) ??
                  "Optional column header tool tip...",
              }))}
              columnWidths={visibleColumnWidths}
              getRowId={(artifact) => artifact.id}
              gridTemplateColumns={gridTemplateColumns}
              groups={groupedArtifacts}
              headerActions={{
                getFilterContent: (columnId) => {
                  const group = columnFilterGroups.find(
                    (candidate) => candidate.id === columnId
                  );
                  return group ? (
                    <FilterGroupContent group={group} />
                  ) : undefined;
                },
                onGroup: setGroupBy,
                onMove: moveVisibleColumn,
              }}
              isRowSelected={(artifact) => selectedArtifactIds.has(artifact.id)}
              items={displayedArtifacts}
              leadingColumnWidth={artifactColumnWidth}
              leadingLabel="Artifact"
              leadingSortKey="name"
              leadingTooltip="Optional column header tool tip..."
              leadingUtilityHeader={<div aria-hidden className="size-full" />}
              onColumnOrderChange={setColumnOrder}
              onColumnWidthChange={(columnId, widthPx) =>
                setColumnWidths((current) => ({
                  ...current,
                  [columnId]: widthPx,
                }))
              }
              onGroupDrop={
                groupBy === "none" ||
                (groupBy === "status" && !statusBoard.editable) ||
                (secondaryGroupBy === "status" && !statusBoard.editable)
                  ? undefined
                  : (artifact, group, subgroup) => {
                      applyGroupValueChange(artifact.id, groupBy, group.key);
                      if (secondaryGroupBy !== "none" && subgroup) {
                        applyGroupValueChange(
                          artifact.id,
                          secondaryGroupBy,
                          subgroup.key
                        );
                      }
                    }
              }
              onLeadingColumnWidthChange={setArtifactColumnWidth}
              onRowClick={handleArtifactRowClick}
              onRowKeyboardNavigate={handleArtifactRowKeyboardNavigate}
              onSort={(column, direction) => {
                setSortActive(true);
                setSortBy(column);
                setSortDir(direction);
              }}
              renderAfterGroup={
                inlineCreate?.enabled
                  ? (group) => (
                      <InlineArtifactCreateRow
                        active={
                          inlineDraftContext?.groupKey === group.key &&
                          !inlineDraftContext.afterArtifactId
                        }
                        gridTemplateColumns={gridTemplateColumns}
                        label={inlineCreate.label ?? "Add artifact"}
                        onActivate={() =>
                          setInlineDraftContext({ groupKey: group.key })
                        }
                        onCancel={() => setInlineDraftContext(null)}
                        onCommit={(title) =>
                          createInlineArtifact(title, group.key)
                        }
                      />
                    )
                  : undefined
              }
              renderAfterItem={
                inlineCreate?.enabled
                  ? (artifact) =>
                      inlineDraftContext?.afterArtifactId === artifact.id ? (
                        <InlineArtifactCreateRow
                          active
                          gridTemplateColumns={gridTemplateColumns}
                          label={inlineCreate.label ?? "Add artifact"}
                          onActivate={() => undefined}
                          onCancel={() => setInlineDraftContext(null)}
                          onCommit={(title) =>
                            createInlineArtifact(
                              title,
                              inlineDraftContext.groupKey,
                              artifact.id
                            )
                          }
                        />
                      ) : null
                  : undefined
              }
              renderAfterRows={
                inlineCreate?.enabled && groupBy === "none" ? (
                  <InlineArtifactCreateRow
                    active={
                      inlineDraftContext !== null &&
                      !inlineDraftContext.afterArtifactId
                    }
                    gridTemplateColumns={gridTemplateColumns}
                    label={inlineCreate.label ?? "Add artifact"}
                    onActivate={() => setInlineDraftContext({})}
                    onCancel={() => setInlineDraftContext(null)}
                    onCommit={createInlineArtifact}
                  />
                ) : undefined
              }
              renderCell={(columnId, artifact) =>
                extensionColumns
                  .find((column) => column.id === columnId)
                  ?.renderCell(artifact) ??
                renderGenericArtifactCell(
                  columnId,
                  artifact,
                  customFields,
                  updateArtifact
                )
              }
              renderLead={(artifact) => (
                <EditableArtifactLead
                  artifact={artifact}
                  onCommit={updateArtifactTitle}
                  onOpenArtifact={onOpenArtifact}
                  openHref={onOpenArtifactHref?.(artifact)}
                />
              )}
              renderLeadingUtility={(artifact) => (
                <ArtifactRowUtilities
                  artifact={artifact}
                  favorited={favoriteArtifactIds.has(artifact.id)}
                  onFavoriteChange={(favorited) =>
                    setArtifactFavorite(artifact.id, favorited)
                  }
                />
              )}
              sortBy={sortActive ? sortBy : null}
              sortDir={sortDir}
              trailingHeader={
                showAddFieldButton ? (
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
                ) : undefined
              }
            />
          )}
        </TagEditorContext.Provider>
      </div>
      {groupBy === "none" ? (
        <ArtifactTablePagination
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(0);
          }}
          page={clampedPage}
          pageSize={pageSize}
          rangeEnd={Math.min(
            pageStart + pagedArtifacts.length,
            sortedArtifacts.length
          )}
          rangeStart={sortedArtifacts.length === 0 ? 0 : pageStart + 1}
          total={sortedArtifacts.length}
          totalPages={totalPages}
        />
      ) : null}
      {selectedArtifactIds.size >= 2 ? (
        <ArtifactBulkActionBar
          count={selectedArtifactIds.size}
          currentTags={tagDefinitions}
          noun={selectionNoun}
          onAction={applyBulkAction}
          onClear={() => {
            setSelectedArtifactIds(new Set());
            selectionAnchorId.current = null;
          }}
        />
      ) : null}
      <CustomFieldDialog
        onCreate={(field) => {
          setCustomFields((current) => [...current, field]);
          setColumnOrder((current) => [...current, field.id]);
          setColumnWidths((current) => ({ ...current, [field.id]: 180 }));
          setVisibleColumnIds((current) => new Set(current).add(field.id));
        }}
        onOpenChange={setAddFieldOpen}
        open={addFieldOpen}
      />
      <AddArtifactDialog
        config={creationConfig}
        customFields={customFields}
        initialStatus={boardCreationStatus}
        onCreate={(values, options) => {
          const previousArtifacts = artifacts;
          const createdArtifact = buildCreatedArtifact({
            config: creationConfig,
            nextNumber: artifacts.length + 1,
            values,
          });
          const nextArtifact = boardCreationStatus
            ? { ...createdArtifact, status: boardCreationStatus }
            : createdArtifact;
          setArtifacts((current) => [nextArtifact, ...current]);
          setPage(0);
          if (options?.openAfterCreate !== false) {
            onOpenArtifact(nextArtifact);
          }
          toast.success(
            options?.draft
              ? `${nextArtifact.slug} saved as draft`
              : `${nextArtifact.slug} created`,
            {
              action: {
                label: "Undo",
                onClick: () => {
                  setArtifactsState(previousArtifacts);
                  onArtifactsChange?.(previousArtifacts);
                },
              },
            }
          );
        }}
        onOpenChange={(open) => {
          setAddArtifactOpen(open);
          if (!open) {
            setBoardCreationStatus(null);
          }
        }}
        open={addArtifactOpen}
      />
    </div>
  );
}

function InlineArtifactCreateRow({
  active,
  gridTemplateColumns,
  label,
  onActivate,
  onCancel,
  onCommit,
}: {
  active: boolean;
  gridTemplateColumns: string;
  label: string;
  onActivate: () => void;
  onCancel: () => void;
  onCommit: (title: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) {
      inputRef.current?.focus();
    } else {
      setDraft("");
    }
  }, [active]);

  const commit = () => {
    const title = draft.trim();
    if (!title) {
      return;
    }
    onCommit(title);
    setDraft("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div
      className="grid h-11 min-w-fit items-center border-b bg-background"
      data-inline-create-row=""
      style={{ gridTemplateColumns }}
    >
      <div aria-hidden />
      <div className="flex h-full min-w-0 items-center pr-3 pl-4">
        {active ? (
          <Input
            aria-label={`${label} name`}
            className="h-8 w-full"
            onBlur={() => {
              if (!draft.trim()) {
                onCancel();
              }
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                onCancel();
              }
            }}
            placeholder="Issue name"
            ref={inputRef}
            value={draft}
          />
        ) : (
          <button
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-muted-foreground text-sm hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onActivate}
            type="button"
          >
            <PlusIcon className="size-3.5" />
            {label}
          </button>
        )}
      </div>
    </div>
  );
}
