"use client";

import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_TO_ICON,
} from "@repo/app/projects/lib/project-constants";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { useTags } from "@repo/app/tags/hooks/use-tags";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
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

    const statusOptions: TableFilterOption<DocumentStatus>[] = Object.values(
      DocumentStatus
    ).map((status) => ({
      id: status,
      label: DOCUMENT_STATUS_LABELS[status],
      count: filtersReturn.statusCounts.get(status) ?? 0,
      icon: <StatusIcon size={16} status={DOCUMENT_STATUS_TO_ICON[status]} />,
      searchText: DOCUMENT_STATUS_LABELS[status],
    }));

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
