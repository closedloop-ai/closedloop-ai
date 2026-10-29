"use client";

import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import type { ArtifactStatusFacetValue } from "@repo/app/documents/lib/artifact-status-facet-value";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import {
  useFeatureFlagEnabled,
  useFeatureFlagEnabledOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import { documentStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { useTags } from "@repo/app/tags/hooks/use-tags";
import type {
  TableFilterCurrentUser,
  TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useMemo } from "react";
import type {
  DocumentTableFiltersController,
  DocumentTableFiltersViewModel,
  PriorityFacetValue,
} from "./document-table-filters";

type UseDocumentTableFilterUiOptions = {
  currentUser?: TableFilterCurrentUser | null;
  filtersReturn: TableFiltersReturn;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  hideAssignee?: boolean;
};

export function useDocumentTableFilterUi({
  currentUser,
  filtersReturn,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
  hideAssignee,
}: UseDocumentTableFilterUiOptions): {
  controller: DocumentTableFiltersController;
  viewModel: DocumentTableFiltersViewModel;
} {
  const { data: allTags = [] } = useTags();
  const tagsEnabled = useFeatureFlagEnabled("artifact-tags");
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const priorityOrder = usePriorityOptions();

  const controller = useMemo<DocumentTableFiltersController>(
    () => ({
      filters: filtersReturn.filters,
      toggleAssignee: filtersReturn.toggleAssignee,
      toggleAssignToMe: filtersReturn.toggleAssignToMe,
      toggleHideCompletedItems: filtersReturn.toggleHideCompletedItems,
      toggleFavoritesOnly: filtersReturn.toggleFavoritesOnly,
      toggleStatus: filtersReturn.toggleStatus,
      togglePriority: filtersReturn.togglePriority,
      setDateFilter: filtersReturn.setDateFilter,
      toggleTag: filtersReturn.toggleTag,
      clearCategoryFilter: filtersReturn.clearCategoryFilter,
      clearAllFilters: filtersReturn.clearAllFilters,
      activeChips: filtersReturn.activeChips,
    }),
    [filtersReturn]
  );

  const viewModel = useMemo<DocumentTableFiltersViewModel>(() => {
    const teamMemberOptions: TableFilterOption[] = hideAssignee
      ? []
      : [
          {
            id: "__unassigned__",
            label: UNASSIGNED_ASSIGNEE_LABEL,
            count: filtersReturn.assigneeCounts.get("__unassigned__") ?? 0,
            searchText: "unassigned",
          },
          ...teamMembers.map((member) => ({
            id: member.id,
            label: member.name,
            avatarUrl: member.avatarUrl,
            count: filtersReturn.assigneeCounts.get(member.id) ?? 0,
            searchText: member.name,
          })),
        ];

    // Mixed table: offer both vocabularies (PRD-495). IN_REVIEW is shared by
    // Documents and Features, so dedupe to a single filter chip.
    const seenStatuses = new Set<ArtifactStatusFacetValue>();
    const buildOptions = champion
      ? buildUniversalStatusOptions
      : buildStatusOptions;
    const unknownCount =
      filtersReturn.statusCounts.get(DISPLAYED_ARTIFACT_STATUS.Unknown) ?? 0;
    const unknownOptions: TableFilterOption<ArtifactStatusFacetValue>[] = [];
    if (
      champion &&
      // A surface that filters server-side cannot express this value, so it is
      // not offered there (ISS-10472). Read off the filters hook, which is also
      // what drops it from the applied set.
      filtersReturn.canSelectUnknownStatus &&
      (unknownCount > 0 ||
        filtersReturn.filters.statuses.includes(
          DISPLAYED_ARTIFACT_STATUS.Unknown
        ))
    ) {
      const facet = documentStatusFacet(
        DocumentType.Prd,
        DISPLAYED_ARTIFACT_STATUS.Unknown
      );
      const label = artifactStatusLabel(facet);
      unknownOptions.push({
        id: DISPLAYED_ARTIFACT_STATUS.Unknown,
        label,
        content: (
          <UniversalArtifactStatus
            facet={facet}
            variant={ArtifactStatusVariant.FilterOption}
          />
        ),
        count: unknownCount,
        searchText: label,
      });
    }
    const statusOptions: TableFilterOption<ArtifactStatusFacetValue>[] = [
      ...unknownOptions,
      ...buildOptions({
        documentType: DocumentType.Prd,
        sectionLabel: "Document Status",
        seenStatuses,
        statusCounts: filtersReturn.statusCounts,
        statuses: DOCUMENT_STATUS_OPTIONS,
      }),
      ...buildOptions({
        documentType: DocumentType.Feature,
        sectionLabel: "Issue Status",
        seenStatuses,
        statusCounts: filtersReturn.statusCounts,
        statuses: ISSUE_STATUS_OPTIONS,
      }),
    ];

    // The same order the cell editor and the bulk bar offer: a filter listing
    // the vocabulary in the opposite direction to the editor beside it is the
    // drift `usePriorityOptions` exists to prevent.
    const priorityOptions: TableFilterOption<PriorityFacetValue>[] =
      priorityOrder.map((priority) => ({
        id: priority,
        label: PRIORITY_LABELS[priority],
        count: filtersReturn.priorityCounts.get(priority) ?? 0,
        searchText: PRIORITY_LABELS[priority],
      }));
    // ISS-9665: the facet that makes "no priority" filterable, not just
    // visible. Last, matching where an unset priority sorts everywhere else
    // (`comparePriorityValues` ranks it after LOW). Carries the same word the
    // priority group header uses.
    if (unsetPriorityEnabled) {
      priorityOptions.push({
        id: PRIORITY_UNSET_VALUE,
        label: NO_PRIORITY_LABEL,
        count: filtersReturn.priorityCounts.get(PRIORITY_UNSET_VALUE) ?? 0,
        searchText: NO_PRIORITY_LABEL,
      });
    }

    const tagOptions: TableFilterOption[] = allTags.map((tag) => ({
      id: tag.id,
      label: tag.name,
      color: tag.color,
      searchText: tag.name,
    }));

    return {
      currentUser,
      teamMembers: teamMemberOptions,
      teamMembersLoading,
      teamMembersError,
      statusOptions,
      priorityOptions,
      tagOptions,
      hideAssignee,
      showTags: tagsEnabled,
    };
  }, [
    allTags,
    champion,
    currentUser,
    filtersReturn.assigneeCounts,
    filtersReturn.canSelectUnknownStatus,
    filtersReturn.priorityCounts,
    filtersReturn.statusCounts,
    filtersReturn.filters.statuses,
    hideAssignee,
    priorityOrder,
    tagsEnabled,
    unsetPriorityEnabled,
    teamMembers,
    teamMembersError,
    teamMembersLoading,
  ]);

  return { controller, viewModel };
}

function buildStatusOptions({
  documentType: _documentType,
  sectionLabel,
  seenStatuses,
  statusCounts,
  statuses,
}: {
  documentType: DocumentType;
  sectionLabel: string;
  seenStatuses: Set<ArtifactStatusFacetValue>;
  statusCounts: ReadonlyMap<ArtifactStatusFacetValue, number>;
  statuses: readonly ArtifactStatus[];
}): TableFilterOption<ArtifactStatusFacetValue>[] {
  const options: TableFilterOption<ArtifactStatusFacetValue>[] = [];

  for (const status of statuses) {
    if (seenStatuses.has(status)) {
      continue;
    }

    seenStatuses.add(status);
    options.push({
      id: status,
      label: ARTIFACT_STATUS_LABELS[status],
      count: statusCounts.get(status) ?? 0,
      searchText: ARTIFACT_STATUS_LABELS[status],
      sectionLabel,
    });
  }

  return options;
}

function buildUniversalStatusOptions({
  documentType,
  sectionLabel,
  seenStatuses,
  statusCounts,
  statuses,
}: {
  documentType: DocumentType;
  sectionLabel: string;
  seenStatuses: Set<ArtifactStatusFacetValue>;
  statusCounts: ReadonlyMap<ArtifactStatusFacetValue, number>;
  statuses: readonly ArtifactStatus[];
}): TableFilterOption<ArtifactStatusFacetValue>[] {
  const options: TableFilterOption<ArtifactStatusFacetValue>[] = [];

  for (const status of statuses) {
    if (seenStatuses.has(status)) {
      continue;
    }
    seenStatuses.add(status);
    const facet = documentStatusFacet(documentType, status);
    const label = artifactStatusLabel(facet);
    options.push({
      id: status,
      label,
      content: (
        <UniversalArtifactStatus
          facet={facet}
          variant={ArtifactStatusVariant.FilterOption}
        />
      ),
      count: statusCounts.get(status) ?? 0,
      searchText: label,
      sectionLabel,
    });
  }

  return options;
}
