import type { FilterFacetGroup } from "@repo/design-system/components/ui/table-filters";
import { CircleDotIcon, FolderGitIcon } from "lucide-react";
import { toggleFacetValue } from "../../shared/lib/facet-filter";
import {
  type BranchFilters,
  type BranchRow,
  branchRepoFilterOptions,
  branchStatusFilterOptions,
} from "./branch-sample-data";

/**
 * Maps the multi-select Branch filter state to the generic `FilterPopover`
 * facet groups (Status / Repository). Options are derived from the rows in
 * view; toggling a value adds/removes it from that facet's selection and emits
 * a new `BranchFilters`.
 */
export function branchFilterFacetGroups(
  rows: BranchRow[],
  filters: BranchFilters,
  onChange: (next: BranchFilters) => void
): FilterFacetGroup[] {
  return [
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: branchStatusFilterOptions(rows),
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(filters.statuses, value),
        }),
    },
    {
      id: "repo",
      label: "Repository",
      icon: <FolderGitIcon className="size-4" />,
      options: branchRepoFilterOptions(rows),
      selectedValues: filters.repos,
      onToggle: (value) =>
        onChange({ ...filters, repos: toggleFacetValue(filters.repos, value) }),
    },
  ];
}
