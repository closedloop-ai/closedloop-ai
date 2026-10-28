"use client";

import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { ARTIFACT_IDENTITY_COLUMN_WIDTH_PX } from "@repo/app/shared/lib/column-width";
import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { genericArtifactStatusKey } from "../../generic-artifact-status";
import { ArtifactKind, ArtifactStatus } from "../fixtures";
import { useArtifactDateDimension } from "./artifact-date-dimension";
import { clearSelection } from "./artifact-list-bulk-actions";
import type {
  ArtifactFilters,
  ArtifactGroupOrder,
  ArtifactListColumn,
  ArtifactListLayout,
  ArtifactListSummaryMetric,
  CustomFieldFilter,
  GenericArtifactListShellProps,
  PAGE_SIZES,
} from "./artifact-list-model";
import { initialArtifactFilters } from "./artifact-list-model";
import { useArtifactListRouteState } from "./artifact-list-route-state";
import {
  artifactSavedViewRecordSchema,
  buildInitialSavedViews,
  type SavedViewRecord,
} from "./artifact-saved-views";
import { shouldClearArtifactSelectionFromPointerTarget } from "./artifact-selection-dismissal";

type ArtifactListShellStateOptions = Readonly<{
  persistenceKey?: string | null;
  routeState?: GenericArtifactListShellProps["routeState"];
  configuredColumns: readonly ArtifactListColumn[];
  controlledAddArtifactOpen?: boolean;
  /**
   * Whether this surface has a date dimension at all. Absent means no range is
   * initialized, applied, persisted or serialized (ISS-10479).
   */
  dateDimensionPresent: boolean;
  defaultDateRange?: string;
  defaultGroupBy: string;
  defaultVisibleColumnIds?: readonly string[];
  legacyColumnAliases?: GenericArtifactListShellProps["legacyColumnAliases"];
  legacyMetricAliases?: GenericArtifactListShellProps["legacyMetricAliases"];
  onAddArtifactOpenChange?: (open: boolean) => void;
  summaryMetricDefinitions: readonly Omit<ArtifactListSummaryMetric, "value">[];
}>;

/** Owns the route/saved-view/list-control state independently of row mechanics. */
export function useArtifactListShellState({
  routeState,
  persistenceKey,
  configuredColumns,
  controlledAddArtifactOpen,
  dateDimensionPresent,
  defaultDateRange,
  defaultGroupBy,
  defaultVisibleColumnIds,
  legacyColumnAliases,
  legacyMetricAliases,
  onAddArtifactOpenChange,
  summaryMetricDefinitions,
}: ArtifactListShellStateOptions) {
  const dateDimension = useArtifactDateDimension(
    dateDimensionPresent,
    defaultDateRange
  );
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [sortActive, setSortActive] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<TableCollapsedGroups>(
    EMPTY_TABLE_COLLAPSED_GROUPS
  );
  const [groupBy, setGroupBy] = useState(defaultGroupBy);
  const [groupOrder, setGroupOrder] = useState<ArtifactGroupOrder>("custom");
  const [secondaryGroupBy, setSecondaryGroupBy] = useState("none");
  const [secondaryGroupOrder, setSecondaryGroupOrder] =
    useState<ArtifactGroupOrder>("asc");
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);
  const [showEmptySubgroups, setShowEmptySubgroups] = useState(true);
  const [layout, setLayout] = useState<ArtifactListLayout>("list");
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<Set<string>>(
    () => new Set()
  );
  const selectionAnchorId = useRef<string | null>(null);
  const hasSelection = selectedArtifactIds.size > 0;
  useEffect(() => {
    if (!hasSelection) {
      return;
    }
    const clearOnOrdinaryPointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !shouldClearArtifactSelectionFromPointerTarget(event.target, event)
      ) {
        return;
      }
      clearSelection(setSelectedArtifactIds, selectionAnchorId);
    };
    globalThis.document.addEventListener(
      "pointerdown",
      clearOnOrdinaryPointerDown,
      true
    );
    return () =>
      globalThis.document.removeEventListener(
        "pointerdown",
        clearOnOrdinaryPointerDown,
        true
      );
  }, [hasSelection]);
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
  const [customFieldFilters, setCustomFieldFilters] = useState<
    Record<string, CustomFieldFilter>
  >({});
  const [extensionFilters, setExtensionFilters] = useState<
    Record<string, CustomFieldFilter>
  >({});
  const [columnOrder, setColumnOrder] = useViewStatePersistence<string[]>(
    artifactPreferenceKey(persistenceKey, "column-order"),
    configuredColumns.map((column) => column.id),
    {
      validate: (value) =>
        Array.isArray(value) && value.every((id) => typeof id === "string")
          ? value
          : configuredColumns.map((column) => column.id),
    }
  );
  const [columnWidths, setColumnWidths] = useViewStatePersistence<
    Record<string, number>
  >(artifactPreferenceKey(persistenceKey, "column-widths"), {});
  const [artifactColumnWidth, setArtifactColumnWidth] =
    useViewStatePersistence<number>(
      artifactPreferenceKey(persistenceKey, "leading-width"),
      ARTIFACT_IDENTITY_COLUMN_WIDTH_PX
    );
  const [filters, setFilters] = useState<ArtifactFilters>(
    initialArtifactFilters
  );
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useViewStatePersistence<
    (typeof PAGE_SIZES)[number]
  >(artifactPreferenceKey(persistenceKey, "page-size"), 25, {
    validate: (value) =>
      value === 25 || value === 50 || value === 100 ? value : 25,
  });
  const [visibleMetricKeys, setVisibleMetricKeys] = useArtifactPreferenceSet(
    artifactPreferenceKey(persistenceKey, "metrics"),
    summaryMetricDefinitions.map((metric) => metric.key)
  );
  const [visibleColumnIds, setVisibleColumnIds] = useArtifactPreferenceSet(
    artifactPreferenceKey(persistenceKey, "columns"),
    defaultVisibleColumnIds ??
      configuredColumns
        .filter((column) => column.defaultHidden !== true)
        .map((column) => column.id)
  );
  const initialSavedViews = useMemo(
    () =>
      buildInitialSavedViews({
        columnIds: [...visibleColumnIds],
        dateDimension,
        initialFilters: initialArtifactFilters,
        metricKeys: summaryMetricDefinitions.map((metric) => metric.key),
        statuses: {
          active: genericArtifactStatusKey({
            kind: ArtifactKind.Issue,
            status: ArtifactStatus.InProgress,
          }),
          inReview: genericArtifactStatusKey({
            kind: ArtifactKind.Issue,
            status: ArtifactStatus.InReview,
          }),
        },
      }),
    [
      dateDimension.present,
      visibleColumnIds,
      summaryMetricDefinitions,
      dateDimension,
    ]
  );
  const [savedViews, setSavedViews] = useViewStatePersistence<
    SavedViewRecord[]
  >(artifactPreferenceKey(persistenceKey, "saved-views"), initialSavedViews, {
    validate: (value) =>
      Array.isArray(value) && value.every(isPersistedArtifactSavedView)
        ? value
        : initialSavedViews,
  });
  const [activeSavedViewId, setActiveSavedViewId] = useState("default");
  const applySavedView = (viewId: string) => {
    const view = savedViews.find((candidate) => candidate.id === viewId);
    if (!view) {
      return;
    }
    if (dateDimension.present && view.state.dateRange !== undefined) {
      dateDimension.setRange(view.state.dateRange);
    }
    setFilters(view.state.filters);
    setCustomFieldFilters(view.state.customFieldFilters ?? {});
    setExtensionFilters(view.state.extensionFilters ?? {});
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
        ...(dateDimension.present ? { dateRange: dateDimension.range } : {}),
        filters,
        customFieldFilters,
        extensionFilters,
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
    routeState,
    activeSavedViewId,
    collapsedGroups,
    setCollapsedGroups,
    customFieldFilters,
    dateDimension,
    defaultGroupBy,
    extensionFilters,
    filters,
    groupBy,
    groupOrder,
    layout,
    legacyColumnAliases,
    legacyMetricAliases,
    secondaryGroupBy,
    secondaryGroupOrder,
    setActiveSavedViewId,
    setCustomFieldFilters,
    setExtensionFilters,
    setFilters,
    setGroupBy,
    setGroupOrder,
    setLayout,
    setSecondaryGroupBy,
    setSecondaryGroupOrder,
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

  return {
    activeSavedViewId,
    collapsedGroups,
    setCollapsedGroups,
    addArtifactOpen,
    addFieldOpen,
    applySavedView,
    artifactColumnWidth,
    boardCreationStatus,
    columnOrder,
    columnWidths,
    customFieldFilters,
    dateDimension,
    extensionFilters,
    favoriteArtifactIds,
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
    setActiveSavedViewId,
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
    setLayout,
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
  };
}

function artifactPreferenceKey(
  namespace: string | null | undefined,
  key: string
): string | null {
  return namespace ? `${namespace}:${key}` : null;
}

function useArtifactPreferenceSet(
  key: string | null,
  defaults: readonly string[]
): [Set<string>, (update: SetStateAction<Set<string>>) => void] {
  const [values, setValues] = useViewStatePersistence<string[]>(
    key,
    [...defaults],
    {
      validate: (value) =>
        Array.isArray(value) && value.every((id) => typeof id === "string")
          ? value
          : [...defaults],
    }
  );
  const value = useMemo(() => new Set(values), [values]);
  return [
    value,
    (update) =>
      setValues((previous) => [
        ...(typeof update === "function" ? update(new Set(previous)) : update),
      ]),
  ];
}

function isPersistedArtifactSavedView(
  value: unknown
): value is SavedViewRecord {
  return artifactSavedViewRecordSchema.safeParse(value).success;
}
