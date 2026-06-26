import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type {
  FilterFacetGroup,
  TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import { CircleDotIcon, FolderGitIcon } from "lucide-react";
import { toggleFacetValue } from "../../shared/lib/facet-filter";
import { SESSION_STATUS_LABELS } from "./session-sort-group";

/** Multi-select Sessions filter selections (mirror the server query arrays). */
export type SessionFacetFilters = {
  statuses: string[];
  userIds: string[];
  repositories: string[];
};

export const DEFAULT_SESSION_FACET_FILTERS: SessionFacetFilters = {
  statuses: [],
  userIds: [],
  repositories: [],
};

// Fixed status options (same vocabulary the prior single-select menu used, so
// the server-side artifact.status comparison is unchanged — just multi-select).
// Shares the label map with the Status group headers for consistency.
const STATUS_OPTIONS: TableFilterOption[] = Object.entries(
  SESSION_STATUS_LABELS
).map(([id, label]) => ({ id, label }));

function shortRepoName(repo: string): string {
  const segments = repo.split("/").filter(Boolean);
  return segments.at(-1) ?? repo;
}

function repositoryOptions(
  usage?: AgentSessionUsageSummary
): TableFilterOption[] {
  return (usage?.byRepository ?? []).map((entry) => ({
    id: entry.repositoryFullName,
    label: shortRepoName(entry.repositoryFullName),
    count: entry.sessionCount,
    searchText: entry.repositoryFullName,
  }));
}

/**
 * Map the Sessions filter selections to the generic `FilterPopover` facet groups
 * (Status / Repository). Repository options come from the usage summary's
 * `byRepository` breakdown (the full corpus, not the current page), so the facet
 * stays correct under server-side pagination.
 */
export function sessionFilterFacetGroups(
  filters: SessionFacetFilters,
  onChange: (next: SessionFacetFilters) => void,
  usage?: AgentSessionUsageSummary
): FilterFacetGroup[] {
  return [
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: STATUS_OPTIONS,
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
      options: repositoryOptions(usage),
      selectedValues: filters.repositories,
      onToggle: (value) =>
        onChange({
          ...filters,
          repositories: toggleFacetValue(filters.repositories, value),
        }),
    },
  ];
}
