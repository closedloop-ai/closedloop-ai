import type {
  AgentComponent,
  Harness,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import type { FilterFacetGroup } from "@repo/design-system/components/ui/table-filters";
import { BotIcon, FolderGitIcon, UsersIcon } from "lucide-react";
import { toggleFacetValue } from "../../../shared/lib/facet-filter";
import {
  type AgentComponentFilters,
  filterAgentComponentRows,
} from "../../hooks/use-agent-components-filter-state";
import {
  type AgentComponentActiveFilters,
  countFacetValues,
} from "../../lib/agent-component-sort-group";

/**
 * Maps the multi-select Agents workspace filter state to the generic
 * `FilterPopover` facet groups (Authors / Source / Harness).
 *
 * Options are derived from `countFacetValues` so each option shows how many
 * items the selection would add on top of the current type-tab and other active
 * facet narrowing. Zero-count options are included (shown grayed) so the menu
 * remains stable as filters change.
 *
 * Mirrors the `branchFilterFacetGroups` pattern from
 * `packages/app/branches/lib/branch-filter-adapter.tsx`.
 *
 * ISS-5009: this is a plain function, not a hook, so the Source-provenance flag
 * arrives as `honestSourceEnabled` from the mounting component and is forwarded
 * to the facet builders. The caller MUST pass the same value it passes to
 * `useAgentComponentsFilterState`, or the menu it renders offers options the
 * membership predicate cannot match.
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
 *     facetGroups: agentComponentFilterFacetGroups(filteredRows, allRows, filters, onChange, honestSourceEnabled),
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
  onChange: (next: AgentComponentFilters) => void,
  /** ISS-5009 Source-provenance honesty flag, resolved once by the caller. */
  honestSourceEnabled: boolean
): FilterFacetGroup[] {
  const activeFilters: AgentComponentActiveFilters = {
    kinds: filters.kinds,
    collaborators: filters.collaborators,
    sources: filters.sources,
    harnesses: filters.harnesses,
    search: filters.search,
  };

  // Harness option counts must ignore the active harness selection, otherwise
  // once one harness is checked the other reads 0 even though checking it would
  // add its rows through the OR predicate (wongk, FEA-4336). Re-filter the full
  // corpus with the harness facet cleared so each harness option honestly
  // previews how many rows toggling it surfaces. When no harness is selected
  // this is exactly `rows`, so the extra pass only runs while a harness is
  // active.
  const harnessCountRows =
    filters.harnesses.length === 0
      ? rows
      : filterAgentComponentRows(
          allRows,
          { ...filters, harnesses: [] },
          honestSourceEnabled
        );

  const { collaborators, sources, harnesses } = countFacetValues(
    rows,
    allRows,
    activeFilters,
    harnessCountRows,
    honestSourceEnabled
  );

  return [
    {
      id: "collaborator",
      label: AGENT_COMPONENT_AUTHORS_LABEL,
      icon: <UsersIcon className="size-4" />,
      options: collaborators,
      selectedValues: filters.collaborators,
      onToggle: (value) =>
        onChange({
          ...filters,
          collaborators: toggleFacetValue(filters.collaborators, value),
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
