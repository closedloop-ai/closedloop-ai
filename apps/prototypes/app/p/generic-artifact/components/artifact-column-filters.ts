import type { ArtifactKind, ArtifactStatus } from "../mock";
import {
  type ArtifactFilterController,
  datePresetLabel,
} from "./artifact-list-model";
import type { FilterMenuGroup } from "./experimental/filter-popover";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFiltersViewModel,
} from "./experimental/filter-popover";

/**
 * Column-id keyed facets for grid header menus. They reuse the same controller
 * as the table-level Filters menu, so both entry points update one canonical
 * state and active-filter count.
 */
export function buildBaseColumnFilterGroups(
  controller: ArtifactFilterController,
  viewModel: TableFiltersViewModel<ArtifactStatus, ArtifactKind>
): FilterMenuGroup[] {
  const dateOptions = [
    TableDatePreset.Last24h,
    TableDatePreset.Last7d,
    TableDatePreset.Last30d,
    TableDatePreset.Last3m,
  ];
  return [
    {
      id: "owner",
      label: "Owner",
      options: viewModel.teamMembers,
      selectedValues: controller.filters.assigneeIds,
      onToggle: controller.toggleAssignee,
    },
    {
      id: "status",
      label: "Status",
      options: viewModel.statusOptions,
      selectedValues: controller.filters.statuses,
      onToggle: (value) => controller.toggleStatus(value as ArtifactStatus),
    },
    {
      id: "updated",
      label: "Updated",
      options: dateOptions.map((preset) => ({
        id: preset,
        label: datePresetLabel(preset),
      })),
      selectedValues: controller.filters.date?.preset
        ? [controller.filters.date.preset]
        : [],
      onToggle: (preset: string) =>
        controller.setDateFilter(
          controller.filters.date?.preset === preset
            ? null
            : {
                field: TableDateFilterField.UpdatedAt,
                preset: preset as TableDatePreset,
              }
        ),
    },
    {
      id: "tags",
      label: "Tags",
      options: viewModel.tagOptions ?? [],
      selectedValues: controller.filters.tagIds,
      onToggle: controller.toggleTag,
      emptyLabel: "No tags created yet",
    },
  ];
}
