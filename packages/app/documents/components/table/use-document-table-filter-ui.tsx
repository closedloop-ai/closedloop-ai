"use client";

import { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  FEATURE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { ArtifactStatusIcon } from "@repo/app/documents/components/artifact-status-icon";
import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { useTags } from "@repo/app/tags/hooks/use-tags";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import type {
  TableFilterCurrentUser,
  TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { UserIcon } from "lucide-react";
import { useMemo } from "react";
import type {
  DocumentTableFiltersController,
  DocumentTableFiltersViewModel,
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
            label: "Unassigned",
            count: filtersReturn.assigneeCounts.get("__unassigned__") ?? 0,
            icon: <UserIcon className="size-4 text-muted-foreground" />,
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
    const seenStatuses = new Set<ArtifactStatus>();
    const statusOptions: TableFilterOption<ArtifactStatus>[] = [
      ...buildStatusOptions({
        sectionLabel: "Document Status",
        seenStatuses,
        statusCounts: filtersReturn.statusCounts,
        statuses: DOCUMENT_STATUS_OPTIONS,
      }),
      ...buildStatusOptions({
        sectionLabel: "Feature Status",
        seenStatuses,
        statusCounts: filtersReturn.statusCounts,
        statuses: FEATURE_STATUS_OPTIONS,
      }),
    ];

    const priorityOptions: TableFilterOption<Priority>[] = Object.values(
      Priority
    ).map((priority) => ({
      id: priority,
      label: PRIORITY_LABELS[priority],
      count: filtersReturn.priorityCounts.get(priority) ?? 0,
      icon: <PriorityIcon priority={priority} size={16} />,
      searchText: PRIORITY_LABELS[priority],
    }));

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
    currentUser,
    filtersReturn.assigneeCounts,
    filtersReturn.priorityCounts,
    filtersReturn.statusCounts,
    hideAssignee,
    tagsEnabled,
    teamMembers,
    teamMembersError,
    teamMembersLoading,
  ]);

  return { controller, viewModel };
}

function buildStatusOptions({
  sectionLabel,
  seenStatuses,
  statusCounts,
  statuses,
}: {
  sectionLabel: string;
  seenStatuses: Set<ArtifactStatus>;
  statusCounts: ReadonlyMap<string, number>;
  statuses: readonly ArtifactStatus[];
}): TableFilterOption<ArtifactStatus>[] {
  const options: TableFilterOption<ArtifactStatus>[] = [];

  for (const status of statuses) {
    if (seenStatuses.has(status)) {
      continue;
    }

    seenStatuses.add(status);
    options.push({
      id: status,
      label: ARTIFACT_STATUS_LABELS[status],
      count: statusCounts.get(status) ?? 0,
      icon: <ArtifactStatusIcon size={16} status={status} />,
      searchText: ARTIFACT_STATUS_LABELS[status],
      sectionLabel,
    });
  }

  return options;
}
