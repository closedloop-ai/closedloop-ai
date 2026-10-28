import type { Harness } from "@repo/api/src/types/agent-component";
import type {
  AgentComponentFacetCounts,
  AgentComponentFilters,
} from "@repo/api/src/utils/agent-component-reduce";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import type { FilterFacetGroup } from "@repo/design-system/components/ui/table-filters";
import { toggleFacetValue } from "../../../shared/lib/facet-filter";

/**
 * Maps the Agents workspace's facet counts to the generic `FilterPopover` facet
 * groups (Authors / Source / Harness).
 *
 * Mirrors the `branchFilterFacetGroups` pattern from
 * `packages/app/branches/lib/branch-filter-adapter.tsx`.
 *
 * ISS-6822: this takes the COUNTS, not the rows. It used to take the filtered
 * rows plus the whole inventory corpus and call `countFacetValues` itself, which
 * made the filter menu a second reason the browser needed the entire population
 * in memory — and put the ISS-5009 source-projection flag in a second place
 * where it had to agree with the membership predicate. The counting now happens
 * once, wherever the population is (`useAgentsInventoryView` on the legacy path,
 * the producer on the bounded one), and this stays presentational: labels,
 * icons, selection, and the toggle handlers.
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
 *     facetGroups: agentComponentFilterFacetGroups(facets, filters, onChange),
 *   }}
 * />
 * ```
 */
export function agentComponentFilterFacetGroups(
  /**
   * Per-option counts and the complete value universe, already reduced. The
   * Source options carry whichever projection (`honestSource` or the legacy
   * echo) the membership predicate was given, because one reduction produced
   * both — an option counted under one projection and matched under the other
   * would offer a positive count that selects zero rows (ISS-5009).
   */
  facets: AgentComponentFacetCounts,
  filters: AgentComponentFilters,
  onChange: (next: AgentComponentFilters) => void
): FilterFacetGroup[] {
  return [
    {
      id: "collaborator",
      label: AGENT_COMPONENT_AUTHORS_LABEL,
      options: facets.collaborators,
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
      options: facets.sources,
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
      options: facets.harnesses,
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
