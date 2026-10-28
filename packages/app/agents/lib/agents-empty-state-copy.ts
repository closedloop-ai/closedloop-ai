import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  type AgentComponentFilters,
  normalizedSearch,
} from "@repo/api/src/utils/agent-component-reduce";
import { AGENTS_TIME_RANGE_LABELS, AgentsTimeRange } from "./agents-timeframe";
import { HARNESS_META, kindMeta } from "./component-meta";

/**
 * The Agents inventory's empty-state sentences, extracted from
 * `agents-grouped-list.tsx` by ISS-9398. The type-tab vocabulary they are keyed
 * by is the sibling `agents-type-tab-vocabulary.ts`.
 *
 * `AgentsListSurfaceV2` assembles its view model in a hook, and a hook reaching
 * into a component module for two pure functions would make the v2 surface
 * depend on the v1 composition it replaces. Both hosts' empty copy is the same
 * copy either way, so the sentences live beside the timeframe and kind metadata
 * they are derived from.
 */

/** The type-tab value that narrows nothing. */
export const ALL_TYPES = "all" as const;

/** A selected type tab: one kind, or every kind. */
export type AgentsTypeTabValue = AgentComponentKind | typeof ALL_TYPES;

// FEA-3178: strips the leading "Last " from a window label ("Last 30 days" →
// "30 days"). Top-level per lint/performance/useTopLevelRegex.
const LEADING_LAST_RE = /^Last\s+/i;

/**
 * The active window as a bare noun phrase — "30 days" from "Last 30 days".
 *
 * One helper for both readers (the delta-chip caption "vs prev 30 days" and the
 * windowed empty sentences) so the two can never name the same window
 * differently.
 */
export function agentsWindowNoun(timeRange: AgentsTimeRange): string {
  return AGENTS_TIME_RANGE_LABELS[timeRange]
    .replace(LEADING_LAST_RE, "")
    .toLowerCase();
}

/**
 * Empty-state copy for the current tab + window. FEA-4019 promotes four
 * likely-sparse tabs (Tools/MCPs/Hooks) on web, so a generic "No components
 * match the current filters." lands on most first clicks and wrongly implies a
 * filter the user never set. When the only narrowing is the type tab + time
 * window (no facet/search filter), name the kind and the window instead so the
 * message is honest about why the list is empty; fall back to the filter copy
 * only when a facet or search filter really is active.
 *
 * FEA-4086: the Plugins tab is an installed-plugins inventory (the desktop
 * component-scanner projects installed `agent_packs` into `kind:"plugin"` rows;
 * web surfaces the same rows). An empty Plugins tab means nothing is installed,
 * so — when `isHonestPluginsEmpty` — it gets its own honest copy, "No plugins
 * installed", scoped to the active harness when `harnessScope` is set, rather
 * than the vaguer "No plugins yet." or the misleading filter copy. This string
 * is the `EmptyState` title; the pointer to the Packs page is the caller's
 * `EmptyState` description (`emptyNode`), so it is not baked into this string.
 */
export function emptyStateMessage(
  activeKindTab: AgentsTypeTabValue,
  timeRange: AgentsTimeRange,
  hasActiveFacetOrSearch: boolean,
  isHonestPluginsEmpty: boolean,
  harnessScope?: string
): string {
  // FEA-4086: the Plugins-tab "nothing installed" state wins over the generic
  // filter copy even when a single harness facet is the only narrowing, so it
  // is checked before hasActiveFacetOrSearch.
  if (isHonestPluginsEmpty) {
    const scopeSuffix = harnessScope ? ` for ${harnessScope}` : "";
    return `No plugins installed${scopeSuffix}.`;
  }
  if (hasActiveFacetOrSearch) {
    return "No components match the current filters.";
  }
  const kindNoun =
    activeKindTab === ALL_TYPES
      ? "components"
      : kindMeta(activeKindTab).plural.toLowerCase();
  if (timeRange === AgentsTimeRange.All) {
    return `No ${kindNoun} yet.`;
  }
  const windowLabel = agentsWindowNoun(timeRange);
  // FEA-4086: a windowed Plugins tab drops plugins with zero in-window usage
  // (`dropZeroWindowUsage` on the API), so an empty windowed Plugins tab means
  // "none USED in this window" — not "none in the last N days" (which reads as
  // "none installed"). Word it as usage so it never claims the inventory is
  // empty when the window is what emptied the list.
  if (activeKindTab === AgentComponentKind.Plugin) {
    return `No plugins used in the last ${windowLabel}.`;
  }
  return `No ${kindNoun} in the last ${windowLabel}.`;
}

/**
 * FEA-4086: the display label for the harness the empty Plugins-tab copy is
 * scoped to. A harness scope is claimed only when the Plugins tab is active,
 * a SINGLE harness facet is selected, and NO other facet or search narrows the
 * view — so "No plugins installed for Claude." is only shown when the harness
 * really is the sole narrowing. With no harness facet the inventory spans every
 * harness (no scope claimed); with several selected there is no single harness
 * to name; with an owner/source/search filter the view is a filtered one, not
 * an honest install state. Returns undefined in all of those cases.
 *
 * The lone facet must also be a NAMEABLE single harness: `Harness.Both` is the
 * rollup's "used across more than one harness" marker, not one harness, and its
 * label is "Multiple harnesses". "No plugins installed for Multiple harnesses."
 * would misread as a compound scope, so a `Both`-only facet claims no scope and
 * falls back to the unscoped "No plugins installed." copy.
 *
 * Search is read through `normalizedSearch` so a whitespace-only box counts as
 * no search here exactly as it does in `filterAgentComponentRows` — the two
 * boundaries must agree or a single space empties the list while this still
 * claims a scoped install state.
 */
export function pluginHarnessScope(
  activeKindTab: AgentsTypeTabValue,
  filters: AgentComponentFilters
): string | undefined {
  const harnessOnly =
    filters.harnesses.length === 1 &&
    filters.collaborators.length === 0 &&
    filters.sources.length === 0 &&
    normalizedSearch(filters) === "";
  if (activeKindTab !== AgentComponentKind.Plugin || !harnessOnly) {
    return undefined;
  }
  const only = filters.harnesses[0];
  // `Both` is not a single nameable harness — skip the scope suffix.
  if (only === Harness.Both) {
    return undefined;
  }
  return HARNESS_META[only].label;
}

/**
 * Whether a facet or the search box is narrowing the view — the narrowings that
 * make the empty state read as "your filter matched nothing".
 *
 * The type tab and the time window are deliberately NOT counted: they are the
 * tab the reader is on and the window they picked, and naming them "filters"
 * is what made a sparse Tools tab claim a filter nobody set.
 *
 * Shared because both branches of `agent-ops-complete-surface` decide the same
 * sentence from it. Two copies of a truth-claim is the ISS-9216 divergence class
 * one level below the props it was closed at.
 */
export function hasActiveAgentsFacetOrSearch(
  filters: AgentComponentFilters
): boolean {
  return (
    filters.collaborators.length > 0 ||
    filters.sources.length > 0 ||
    filters.harnesses.length > 0 ||
    normalizedSearch(filters) !== ""
  );
}

/**
 * Whether the Plugins tab's empty is the honest "nothing is installed" state
 * (FEA-4086) rather than a filtered or windowed one.
 *
 * Only true for the ALL-TIME window: a windowed read drops plugins with zero
 * in-window usage, so an empty windowed Plugins tab means "none USED in this
 * window" and claiming the inventory is empty would lie about it.
 */
export function isHonestAgentsPluginsEmpty(
  activeKindTab: AgentsTypeTabValue,
  timeRange: AgentsTimeRange,
  filters: AgentComponentFilters
): boolean {
  return (
    activeKindTab === AgentComponentKind.Plugin &&
    timeRange === AgentsTimeRange.All &&
    (!hasActiveAgentsFacetOrSearch(filters) ||
      pluginHarnessScope(activeKindTab, filters) !== undefined)
  );
}
