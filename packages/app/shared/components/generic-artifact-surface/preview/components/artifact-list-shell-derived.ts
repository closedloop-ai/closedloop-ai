"use client";

import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { orderGroupEntries } from "@repo/app/shared/lib/table-grouping";
import type { GridTableV2Group as GridTableGroup } from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";
import {
  genericArtifactStatusKeyLabel,
  genericArtifactStatusMatchesAny,
  genericArtifactStatusRoot,
} from "../../generic-artifact-status";
import type { ArtifactKind, GenericArtifact } from "../fixtures";
import {
  type ArtifactDateDimension,
  withinArtifactDateDimension,
} from "./artifact-date-dimension";
import { useArtifactHierarchyView } from "./artifact-hierarchy-view";
import {
  compareGenericArtifactStatus,
  genericArtifactCompare,
  genericArtifactSortValue,
} from "./artifact-list-custom-cells";
import { matchesCustomFieldFilters } from "./artifact-list-custom-field-model";
import {
  ARTIFACT_GROUP_NO_VALUE,
  artifactGroupDefinitions,
  buildArtifactSubgroups,
} from "./artifact-list-grouping";
import {
  type ArtifactFilters,
  type ArtifactGroupOrder,
  type ArtifactListColumnExtension,
  type ArtifactListLayout,
  buildFilterController,
  buildSummaryMetrics,
  type CustomFieldFilter,
  type GenericArtifactListShellProps,
  matchesExtensionFilters,
  updatedPresetMinutes,
} from "./artifact-list-model";

type ArtifactListDerivedOptions = Readonly<{
  artifacts: readonly GenericArtifact[];
  boardRootOnly?: boolean;
  textFilter?: string;
  currentUserName?: string;
  currentUserId?: string;
  buildConfiguredSummaryMetrics: GenericArtifactListShellProps["buildSummaryMetrics"];
  creationKind: ArtifactKind;
  customFieldFilters: Record<string, CustomFieldFilter>;
  customFields: CustomFieldDefinition[];
  dateDimension: ArtifactDateDimension;
  extensionColumns: readonly ArtifactListColumnExtension[];
  extensionFilters: Record<string, CustomFieldFilter>;
  favoriteArtifactIds: ReadonlySet<string>;
  filters: ArtifactFilters;
  groupBy: string;
  groupOrder: ArtifactGroupOrder;
  hierarchy: GenericArtifactListShellProps["hierarchy"];
  layout: ArtifactListLayout;
  page: number;
  pageSize: number;
  secondaryGroupBy: string;
  secondaryGroupOrder: ArtifactGroupOrder;
  setFilters: Dispatch<SetStateAction<ArtifactFilters>>;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  sortActive: boolean;
  sortBy: string;
  sortDir: SortDirection;
}>;

/** Derives filtered, sorted, grouped, paged rows from the shell's view state. */
export function useArtifactListShellDerived({
  artifacts,
  boardRootOnly = false,
  textFilter,
  currentUserName = "Ottilie Eastwick",
  currentUserId,
  buildConfiguredSummaryMetrics,
  creationKind,
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
}: ArtifactListDerivedOptions) {
  const filteredArtifacts = useMemo(() => {
    const updatedMinutes = updatedPresetMinutes(filters.updatedPreset);
    return artifacts.filter(
      (artifact) =>
        (!textFilter ||
          `${artifact.slug} ${artifact.title}`
            .toLowerCase()
            .includes(textFilter.toLowerCase())) &&
        withinArtifactDateDimension(
          dateDimension,
          artifact.updatedAgoMinutes
        ) &&
        (!filters.mineOnly ||
          (artifact.ownerId === undefined
            ? artifact.owner === currentUserName
            : artifact.ownerId === currentUserId)) &&
        (!filters.favoritesOnly || favoriteArtifactIds.has(artifact.id)) &&
        (filters.owners.length === 0 ||
          filters.owners.includes(artifact.ownerId ?? artifact.owner)) &&
        genericArtifactStatusMatchesAny(artifact, filters.statuses) &&
        (filters.kinds.length === 0 || filters.kinds.includes(artifact.kind)) &&
        (filters.tags.length === 0 ||
          filters.tags.some((tag) =>
            (artifact.tagIds ?? artifact.tags).includes(tag)
          )) &&
        (updatedMinutes === null ||
          artifact.updatedAgoMinutes <= updatedMinutes) &&
        matchesCustomFieldFilters(
          artifact,
          customFields,
          customFieldFilters,
          artifacts
        ) &&
        matchesExtensionFilters(artifact, extensionColumns, extensionFilters)
    );
  }, [
    artifacts,
    textFilter,
    currentUserName,
    currentUserId,
    customFieldFilters,
    customFields,
    dateDimension,
    extensionColumns,
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
  const compareArtifacts = useCallback(
    (left: GenericArtifact, right: GenericArtifact) => {
      if (sortBy === "status") {
        return compareGenericArtifactStatus(left, right, sortDir);
      }
      const extension = extensionColumns.find((column) => column.id === sortBy);
      const leftValue =
        extension?.sortValue?.(left) ??
        genericArtifactSortValue(left, sortBy, customFields, artifacts);
      const rightValue =
        extension?.sortValue?.(right) ??
        genericArtifactSortValue(right, sortBy, customFields, artifacts);
      const comparison = genericArtifactCompare(leftValue, rightValue, sortBy);
      return comparison * (sortDir === "asc" ? 1 : -1);
    },
    [artifacts, customFields, extensionColumns, sortBy, sortDir]
  );
  const filterController = useMemo(
    () => buildFilterController(filters, setFilters),
    [filters, setFilters]
  );
  const filtersActive =
    Boolean(textFilter?.trim()) ||
    filterController.activeChips.length > 0 ||
    Object.values(customFieldFilters).some(hasActiveFieldFilter) ||
    Object.values(extensionFilters).some(hasActiveFieldFilter);
  const hierarchyView = useArtifactHierarchyView({
    artifacts,
    compareArtifacts,
    filteredArtifacts,
    filtersActive,
    hierarchy,
    sortActive,
  });
  const flatSortedArtifacts = useMemo(() => {
    if (!sortActive) {
      return filteredArtifacts;
    }
    return [...filteredArtifacts].sort(compareArtifacts);
  }, [compareArtifacts, filteredArtifacts, sortActive]);
  const hierarchyListEnabled = hierarchyView.enabled && layout === "list";
  let sortedArtifacts = flatSortedArtifacts;
  if (hierarchyListEnabled) {
    sortedArtifacts = hierarchyView.orderedArtifacts;
  } else if ((hierarchyView.enabled || boardRootOnly) && layout === "board") {
    sortedArtifacts = flatSortedArtifacts.filter(
      (artifact) => !artifact.parentArtifactId
    );
  }
  const groupValueForArtifact = useCallback(
    (artifact: GenericArtifact, fieldId: string) => {
      if (fieldId === "status") {
        return genericArtifactStatusRoot(artifact);
      }
      if (fieldId === "owner" && artifact.ownerId !== undefined) {
        return artifact.ownerId ?? ARTIFACT_GROUP_NO_VALUE;
      }
      const extension = extensionColumns.find(
        (column) => column.id === fieldId
      );
      const raw =
        extension?.groupValue?.(artifact) ??
        genericArtifactSortValue(artifact, fieldId, customFields, artifacts);
      const value = String(raw).trim();
      return value || ARTIFACT_GROUP_NO_VALUE;
    },
    [artifacts, customFields, extensionColumns]
  );
  const groupDescriptor = useCallback(
    (fieldId: string, value: string) => {
      if (fieldId === "status") {
        return { key: value, label: genericArtifactStatusKeyLabel(value) };
      }
      if (fieldId === "owner") {
        if (value === ARTIFACT_GROUP_NO_VALUE) {
          return { key: value, label: "Unassigned" };
        }
        const owner = artifacts.find((artifact) => artifact.ownerId === value);
        if (owner) {
          return { key: value, label: owner.owner };
        }
      }
      const extension = extensionColumns.find(
        (column) => column.id === fieldId
      );
      return {
        key: value,
        label: extension?.valueLabel?.(value, artifacts) ?? value,
      };
    },
    [artifacts, extensionColumns]
  );
  const representedKinds = useMemo(
    () => [
      ...new Set([...artifacts.map((artifact) => artifact.kind), creationKind]),
    ],
    [artifacts, creationKind]
  );
  const hasUnknownStatus = artifacts.some(
    (artifact) =>
      genericArtifactStatusRoot(artifact) === DISPLAYED_ARTIFACT_STATUS.Unknown
  );
  const groupedArtifacts = useMemo<
    GridTableGroup<GenericArtifact>[] | undefined
  >(
    () =>
      buildGroups({
        ownerArtifacts: artifacts,
        groupBy,
        groupDescriptor,
        groupOrder,
        groupValueForArtifact,
        hasUnknownStatus,
        hierarchyView,
        hierarchyListEnabled,
        representedKinds,
        secondaryGroupBy,
        secondaryGroupOrder,
        showEmptyGroups,
        showEmptySubgroups,
        sortedArtifacts,
      }),
    [
      artifacts,
      groupBy,
      groupDescriptor,
      groupOrder,
      groupValueForArtifact,
      hasUnknownStatus,
      hierarchyView,
      hierarchyListEnabled,
      representedKinds,
      secondaryGroupBy,
      secondaryGroupOrder,
      showEmptyGroups,
      showEmptySubgroups,
      sortedArtifacts,
    ]
  );
  const totalPages = Math.max(1, Math.ceil(sortedArtifacts.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageStart = clampedPage * pageSize;
  const pagedArtifacts = sortedArtifacts.slice(pageStart, pageStart + pageSize);
  const displayedArtifacts =
    groupBy === "none" ? pagedArtifacts : sortedArtifacts;

  return {
    matchingArtifacts: filteredArtifacts,
    clampedPage,
    displayedArtifacts,
    filterController,
    filtersActive,
    groupedArtifacts,
    hierarchyView,
    pageStart,
    pagedArtifacts,
    sortedArtifacts,
    summaryMetrics,
    totalPages,
  };
}

function hasActiveFieldFilter(filter: CustomFieldFilter): boolean {
  return Boolean(
    filter.selectedValues?.length ||
      filter.min !== undefined ||
      filter.max !== undefined
  );
}

function buildGroups({
  ownerArtifacts,
  groupBy,
  groupDescriptor,
  groupOrder,
  groupValueForArtifact,
  hasUnknownStatus,
  hierarchyView,
  hierarchyListEnabled,
  representedKinds,
  secondaryGroupBy,
  secondaryGroupOrder,
  showEmptyGroups,
  showEmptySubgroups,
  sortedArtifacts,
}: Readonly<{
  groupBy: string;
  groupDescriptor: (
    fieldId: string,
    value: string
  ) => { key: string; label: string };
  groupOrder: ArtifactGroupOrder;
  groupValueForArtifact: (artifact: GenericArtifact, fieldId: string) => string;
  hasUnknownStatus: boolean;
  hierarchyView: ReturnType<typeof useArtifactHierarchyView>;
  hierarchyListEnabled: boolean;
  representedKinds: readonly ArtifactKind[];
  secondaryGroupBy: string;
  secondaryGroupOrder: ArtifactGroupOrder;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  ownerArtifacts: readonly GenericArtifact[];
  sortedArtifacts: readonly GenericArtifact[];
}>): GridTableGroup<GenericArtifact>[] | undefined {
  if (groupBy === "none") {
    return undefined;
  }
  const groups = new Map<string, { items: GenericArtifact[]; label: string }>();
  const groupingUnits = hierarchyListEnabled
    ? hierarchyView.rootGroups.map((group) => ({
        items: group.artifacts,
        keyArtifact: group.root,
      }))
    : sortedArtifacts.map((artifact) => ({
        items: [artifact],
        keyArtifact: artifact,
      }));
  const groupingRootById = new Map(
    groupingUnits.flatMap((unit) =>
      unit.items.map((item) => [item.id, unit.keyArtifact] as const)
    )
  );
  for (const unit of groupingUnits) {
    const descriptor = groupDescriptor(
      groupBy,
      groupValueForArtifact(unit.keyArtifact, groupBy)
    );
    const current = groups.get(descriptor.key);
    groups.set(descriptor.key, {
      items: [...(current?.items ?? []), ...unit.items],
      label: descriptor.label,
    });
  }
  const definitions = artifactGroupDefinitions(
    groupBy,
    representedKinds,
    hasUnknownStatus,
    ownerArtifacts
  );
  if (showEmptyGroups) {
    for (const definition of definitions) {
      if (!groups.has(definition.key)) {
        groups.set(definition.key, { items: [], label: definition.label });
      }
    }
  }
  const orderedEntries = orderGroupEntries(
    [...groups.entries()].filter(
      ([, group]) => showEmptyGroups || group.items.length > 0
    ),
    groupOrder,
    definitions.map((definition) => definition.key)
  );
  return orderedEntries.map(([key, group]) => ({
    items: group.items,
    key,
    label: group.label,
    subgroups:
      secondaryGroupBy === "none"
        ? undefined
        : buildArtifactSubgroups({
            artifacts: group.items,
            definitions: artifactGroupDefinitions(
              secondaryGroupBy,
              representedKinds,
              hasUnknownStatus,
              ownerArtifacts
            ),
            descriptorForArtifact: (artifact) =>
              groupDescriptor(
                secondaryGroupBy,
                groupValueForArtifact(
                  hierarchyListEnabled
                    ? (groupingRootById.get(artifact.id) ?? artifact)
                    : artifact,
                  secondaryGroupBy
                )
              ),
            order: secondaryGroupOrder,
            showEmpty: showEmptySubgroups,
          }),
  }));
}
