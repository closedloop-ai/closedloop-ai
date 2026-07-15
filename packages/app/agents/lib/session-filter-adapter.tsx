import {
  SESSION_AUTONOMY_TIER_FILTER_OPTIONS,
  SESSION_CHANGE_PRESENCE_OPTIONS,
  SESSION_COST_BUCKETS,
  SESSION_PR_ASSOCIATION_OPTIONS,
} from "@repo/api/src/agent-session-filters";
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type {
  FilterFacetGroup,
  TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import {
  CircleDollarSignIcon,
  CircleDotIcon,
  CpuIcon,
  FolderGitIcon,
  GaugeIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  TerminalIcon,
} from "lucide-react";
// Branches owns repo-name formatting; the sessions filter reuses the canonical branch-row shortRepoName to avoid a duplicate implementation.
import { shortRepoName } from "../../branches/lib/branch-row";
import { toggleFacetValue } from "../../shared/lib/facet-filter";
import { SESSION_STATUS_FILTER_OPTIONS } from "./session-status-filters";

/** Multi-select Sessions filter selections (mirror the server query arrays). */
export type SessionFacetFilters = {
  statuses: string[];
  userIds: string[];
  repositories: string[];
  harnesses: string[];
  models: string[];
  autonomyTiers: string[];
  costBuckets: string[];
  changePresence: string[];
  prAssociation: string[];
};

export const DEFAULT_SESSION_FACET_FILTERS: SessionFacetFilters = {
  statuses: [],
  userIds: [],
  repositories: [],
  harnesses: [],
  models: [],
  autonomyTiers: [],
  costBuckets: [],
  changePresence: [],
  prAssociation: [],
};

/** Options for {@link sessionFilterFacetGroups}. */
export type SessionFilterFacetOptions = {
  /**
   * Include the Changes and Pull request facets (FEA-2505). Gated by the
   * `sessions-change-pr-filters` flag at the call site so the two facets roll
   * out independently of the always-on facets.
   */
  includeChangePrFilters?: boolean;
};

// Fixed status options use the canonical filter contract, so every surface sends
// the same cross-runtime values while preserving the existing Failed label for
// the ERROR status.
const STATUS_OPTIONS: TableFilterOption[] = SESSION_STATUS_FILTER_OPTIONS.map(
  ({ value, label }) => ({ id: value, label })
);

// Autonomy tiers and cost buckets are fixed threshold contracts (SSOT in
// @repo/api), mirroring the fixed Status facet — no data derivation needed.
const AUTONOMY_OPTIONS: TableFilterOption[] =
  SESSION_AUTONOMY_TIER_FILTER_OPTIONS.map(({ value, label }) => ({
    id: value,
    label,
  }));

const COST_OPTIONS: TableFilterOption[] = SESSION_COST_BUCKETS.map(
  ({ id, label }) => ({ id, label })
);

// Changes / Pull request are fixed presence contracts (SSOT in @repo/api),
// mirroring the fixed Status/Autonomy/Cost facets — no data derivation needed.
const CHANGE_PRESENCE_OPTIONS: TableFilterOption[] =
  SESSION_CHANGE_PRESENCE_OPTIONS.map(({ id, label }) => ({ id, label }));

const PR_ASSOCIATION_OPTIONS: TableFilterOption[] =
  SESSION_PR_ASSOCIATION_OPTIONS.map(({ id, label }) => ({ id, label }));

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

// Identity-labeled facet options from a usage breakdown (Harness/Model): the
// options are derived from the full corpus (not the current page), so the facet
// reflects the actual available data and stays correct under server-side
// pagination — the same contract the Repository facet uses (which stays separate
// because it shortens the label).
function breakdownOptions<T extends { sessionCount: number }>(
  entries: readonly T[] | undefined,
  getValue: (entry: T) => string
): TableFilterOption[] {
  return (entries ?? []).map((entry) => {
    const value = getValue(entry);
    return {
      id: value,
      label: value,
      count: entry.sessionCount,
      searchText: value,
    };
  });
}

/**
 * Map the Sessions filter selections to the generic `FilterPopover` facet groups
 * (Status / Autonomy / Harness / Model / Cost / Repository). Categorical options
 * (harness, model, repository) come from the usage summary breakdowns (the full
 * corpus, not the current page), so the facets stay correct under server-side
 * pagination; autonomy tiers and cost buckets are fixed threshold contracts.
 * Every group toggles into `SessionFacetFilters`, which the frontend hooks thread
 * to the API sessions route → service so filtering is applied to the query (and
 * combines with AND semantics across dimensions), not just client-side.
 */
export function sessionFilterFacetGroups(
  filters: SessionFacetFilters,
  onChange: (next: SessionFacetFilters) => void,
  usage?: AgentSessionUsageSummary,
  options?: SessionFilterFacetOptions
): FilterFacetGroup[] {
  const groups: FilterFacetGroup[] = [
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
      id: "autonomy",
      label: "Autonomy",
      icon: <GaugeIcon className="size-4" />,
      options: AUTONOMY_OPTIONS,
      selectedValues: filters.autonomyTiers,
      onToggle: (value) =>
        onChange({
          ...filters,
          autonomyTiers: toggleFacetValue(filters.autonomyTiers, value),
        }),
    },
    {
      id: "harness",
      label: "Harness",
      icon: <TerminalIcon className="size-4" />,
      options: breakdownOptions(usage?.byHarness, (entry) => entry.harness),
      selectedValues: filters.harnesses,
      onToggle: (value) =>
        onChange({
          ...filters,
          harnesses: toggleFacetValue(filters.harnesses, value),
        }),
    },
    {
      id: "model",
      label: "Model",
      icon: <CpuIcon className="size-4" />,
      options: breakdownOptions(usage?.byModel, (entry) => entry.model),
      selectedValues: filters.models,
      onToggle: (value) =>
        onChange({
          ...filters,
          models: toggleFacetValue(filters.models, value),
        }),
    },
    {
      id: "cost",
      label: "Cost",
      icon: <CircleDollarSignIcon className="size-4" />,
      options: COST_OPTIONS,
      selectedValues: filters.costBuckets,
      onToggle: (value) =>
        onChange({
          ...filters,
          costBuckets: toggleFacetValue(filters.costBuckets, value),
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

  // Changes / Pull request roll out behind the sessions-change-pr-filters flag
  // (FEA-2505); when off they are omitted entirely so the selections stay empty
  // and no filter is applied. Inserted before Repository to keep the
  // session-shape facets (changes, PR) adjacent to the other session facets.
  if (options?.includeChangePrFilters) {
    groups.splice(groups.length - 1, 0, {
      id: "changes",
      label: "Changes",
      icon: <GitCompareIcon className="size-4" />,
      options: CHANGE_PRESENCE_OPTIONS,
      selectedValues: filters.changePresence,
      onToggle: (value) =>
        onChange({
          ...filters,
          changePresence: toggleFacetValue(filters.changePresence, value),
        }),
    });
    groups.splice(groups.length - 1, 0, {
      id: "pr",
      label: "Pull request",
      icon: <GitPullRequestIcon className="size-4" />,
      options: PR_ASSOCIATION_OPTIONS,
      selectedValues: filters.prAssociation,
      onToggle: (value) =>
        onChange({
          ...filters,
          prAssociation: toggleFacetValue(filters.prAssociation, value),
        }),
    });
  }

  return groups;
}
