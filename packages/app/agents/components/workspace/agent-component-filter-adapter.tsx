import type {
  AgentComponent,
  Harness,
} from "@repo/api/src/types/agent-component";
import type { FilterFacetGroup } from "@repo/design-system/components/ui/table-filters";
import { BotIcon, FolderGitIcon, UserIcon } from "lucide-react";
import { toggleFacetValue } from "../../../shared/lib/facet-filter";
import type { AgentComponentFilters } from "../../hooks/use-agent-components-filter-state";
import {
  type AgentComponentActiveFilters,
  countFacetValues,
} from "../../lib/agent-component-sort-group";

/**
 * Maps the multi-select Agents workspace filter state to the generic
 * `FilterPopover` facet groups (Owner / Source / Harness).
 *
 * Options are derived from `countFacetValues` so each option shows how many
 * items the selection would add on top of the current type-tab and other active
 * facet narrowing. Zero-count options are included (shown grayed) so the menu
 * remains stable as filters change.
 *
 * Mirrors the `branchFilterFacetGroups` pattern from
 * `packages/app/branches/lib/branch-filter-adapter.tsx`.
 *
 * Usage (in a toolbar component):
 * ```tsx
 * import { NOOP_TABLE_FILTERS_CONTROLLER } from "@repo/app/shared/lib/facet-filter";
 *
 * <FilterPopover
 *   controller={NOOP_TABLE_FILTERS_CONTROLLER}
 *   viewModel={{
 *     teamMembers: [],
 *     statusOptions: [],
 *     priorityOptions: [],
 *     hideQuickToggles: true,
 *     facetGroups: agentComponentFilterFacetGroups(filteredRows, allRows, filters, onChange),
 *   }}
 * />
 * ```
 */
export function agentComponentFilterFacetGroups(
  /** Already-filtered rows (type-tab + other active facets applied). */
  rows: AgentComponent[],
  /** Full inventory corpus — used to build the complete value universe for zero-count options. */
  allRows: AgentComponent[],
  filters: AgentComponentFilters,
  onChange: (next: AgentComponentFilters) => void
): FilterFacetGroup[] {
  const activeFilters: AgentComponentActiveFilters = {
    kinds: filters.kinds,
    owners: filters.owners,
    sources: filters.sources,
    harnesses: filters.harnesses,
    search: filters.search,
  };

  const { owners, sources, harnesses } = countFacetValues(
    rows,
    allRows,
    activeFilters
  );

  return [
    {
      id: "owner",
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: owners,
      selectedValues: filters.owners,
      onToggle: (value) =>
        onChange({
          ...filters,
          owners: toggleFacetValue(filters.owners, value),
        }),
    },
    {
      id: "source",
      label: "Source",
      icon: <FolderGitIcon className="size-4" />,
      options: sources,
      selectedValues: filters.sources,
      onToggle: (value) =>
        onChange({
          ...filters,
          sources: toggleFacetValue(filters.sources, value),
        }),
    },
    {
      id: "harness",
      label: "Harness",
      icon: <BotIcon className="size-4" />,
      options: harnesses,
      selectedValues: filters.harnesses as string[],
      onToggle: (value) =>
        onChange({
          ...filters,
          harnesses: toggleFacetValue(
            filters.harnesses as string[],
            value
          ) as Harness[],
        }),
    },
  ];
}
