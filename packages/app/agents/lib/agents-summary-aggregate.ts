/**
 * Agents list summary-card aggregation (ISS-5534).
 *
 * Extracted out of the 1,100-line `agents-grouped-list.tsx` so the four headline
 * aggregates have a lightweight, component-free test target — and so the
 * Invocations de-duplication below can be exercised directly rather than only
 * through a full render.
 *
 * FEA-3178: the current and PRECEDING windows are aggregated by this identical
 * reduction, so the delta chips can never drift between the two populations.
 */

import {
  type AgentComponent,
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
  PLUGIN_CHILD_KIND_SET,
} from "@repo/api/src/types/agent-component";

/**
 * FEA-3178: the four headline aggregates the summary cards display, computed
 * over a population of components. LOC/$ is the average of the non-null
 * per-component ratios.
 */
export type SummaryAggregate = {
  components: number;
  invocations: number;
  /**
   * FEA-4052: average of the non-null per-component LOC/$ ratios, or `null`
   * when no component in the population carries a measured ratio. `null` is
   * kept distinct from a real `0` so the card renders `—` (unavailable) rather
   * than a fabricated `0.0` when a verifiable-kind component exists but has no
   * LOC/$ yet (wongk review, PR #3720).
   */
  avgLocPerDollar: number | null;
  /**
   * FEA-4052: how many components actually contributed a measured LOC/$ ratio
   * to {@link avgLocPerDollar}. Names the real averaged population in the card
   * detail ("avg across N components") so a single verifiable component in a
   * large inventory does not read as an average over everything (wongk review).
   */
  locPerDollarSampleSize: number;
  // FEA-4098 (Slice 3): distinct authors (collaborators) across the view,
  // replacing the distinct-owners count.
  collaborators: number;
  /**
   * FEA-4052: whether the population contains at least one component of a kind
   * with reliable per-component LOC/$ attribution
   * ({@link isLocPerDollarVerifiableKind}). When false the LOC/$ card is HIDDEN
   * entirely rather than rendering `0.0` — no misleading number for a view built
   * only of non-verifiable kinds.
   */
  hasVerifiableLocPerDollar: boolean;
};

/**
 * ISS-5534 — total invocations across a population, counting each invocation
 * exactly ONCE.
 *
 * A `plugin` component is never invoked directly: the API and the desktop reader
 * both REPLACE a plugin row's `invocations`/`sessions` with the SUM of its
 * skill/command/subagent/mcp children's usage (see `plugin-child-usage.ts` and
 * the desktop `pluginUsageSql`). On the "All" type tab the plugin AND the
 * children it was rolled up FROM are both rows in this same population, so a
 * flat sum counts every child invocation twice — once on the child, once inside
 * the plugin's rollup.
 *
 * The de-duplication drops the ROLLUP side, not the leaves, and it drops a given
 * plugin's rollup ONLY when that plugin's OWN represented children are in the
 * population — matched on the `AgentComponent.packIds` parent identity both
 * producers now emit (ISS-5534, wongk review on #4902). When a plugin's children
 * are absent (the Plugins tab, or a facet filter that kept the plugin and
 * excluded its children) its rollup is the ONLY representation of that activity,
 * so it is counted normally; otherwise a plugin with real usage would report a
 * flat 0, and an unrelated child row anywhere in the view would zero every
 * plugin at once.
 *
 * That last case is why the earlier population-wide boolean was wrong rather
 * than merely imprecise: a filter can keep a 500-invocation plugin, exclude its
 * actual children, and retain an unrelated 70-invocation subagent — under one
 * global flag the card rendered 70 where the truth is 570.
 *
 * SKEW. `packIds` is additive and optional, so a producer that predates it omits
 * it everywhere. The PLUGIN row is the probe: when a plugin carries no `packIds`
 * this reader cannot know its parentage, and falls back to the population-wide
 * test — the pre-review behaviour, which can only UNDER-count, never inflate. An
 * absent `packIds` on a CHILD row from a producer that did populate the plugin's
 * is a different and honest answer: a component belonging to no pack, which is
 * therefore not one of this plugin's children.
 */
export function sumDedupedInvocations(
  components: readonly AgentComponent[]
): number {
  const representedPackIds = new Set<string>();
  let hasChildRows = false;
  for (const component of components) {
    if (!PLUGIN_CHILD_KIND_SET.has(component.kind)) {
      continue;
    }
    hasChildRows = true;
    for (const packId of component.packIds ?? []) {
      representedPackIds.add(packId);
    }
  }

  let total = 0;
  for (const component of components) {
    if (
      component.kind === AgentComponentKind.Plugin &&
      rollupIsAlreadyRepresented(component, representedPackIds, hasChildRows)
    ) {
      continue;
    }
    total += component.invocations ?? 0;
  }
  return total;
}

/**
 * Whether this plugin row's rolled-up total is ALREADY represented by child rows
 * in the same population — i.e. whether counting it would count those child
 * invocations a second time.
 *
 * `hasChildRows` is only consulted on the version-skew path (see the SKEW note
 * on {@link sumDedupedInvocations}); when the producer emits `packIds` the answer
 * is the exact intersection of this plugin's pack candidates with the packs the
 * population's child rows actually belong to.
 */
function rollupIsAlreadyRepresented(
  plugin: AgentComponent,
  representedPackIds: ReadonlySet<string>,
  hasChildRows: boolean
): boolean {
  const packIds = plugin.packIds;
  if (packIds === undefined) {
    return hasChildRows;
  }
  return packIds.some((packId) => representedPackIds.has(packId));
}

/**
 * Reduce a component population to the summary-card aggregates.
 *
 * `dedupePluginRollups` is the ISS-5534 closed-by-default UI gate (PostHog on
 * web, Labs on desktop). OFF — the default — reproduces the pre-ISS-5534 flat
 * sum exactly, so the card is byte-for-byte unchanged for every user until the
 * flag is lit on that surface.
 */
export function computeSummaryAggregate(
  components: readonly AgentComponent[],
  dedupePluginRollups = false
): SummaryAggregate {
  const invocations =
    invocationsDerivation(dedupePluginRollups).reduce(components);
  const locPerDollarValues = components
    .map((c) => c.locPerDollar)
    .filter((v): v is number => v !== null);
  const avgLocPerDollar = locPerDollarValues.length
    ? locPerDollarValues.reduce((sum, v) => sum + v, 0) /
      locPerDollarValues.length
    : null;
  const collaborators = new Set(components.flatMap((c) => c.collaborators))
    .size;
  return {
    components: components.length,
    invocations,
    avgLocPerDollar,
    locPerDollarSampleSize: locPerDollarValues.length,
    collaborators,
    hasVerifiableLocPerDollar: components.some((c) =>
      isLocPerDollarVerifiableKind(c.kind)
    ),
  };
}

/**
 * ISS-5534 — the CURRENT and PRECEDING window aggregates, reduced together.
 *
 * FEA-3178 requires both windows to be aggregated by the identical reduction, or
 * the delta chips drift; ISS-5534 adds a second thing that must match, the
 * de-duplication gate. A delta computed from a deduped current against a flat
 * baseline is meaningless — it would report the dedupe itself as a usage drop.
 *
 * Both windows are therefore reduced HERE, from one `dedupePluginRollups`
 * argument, so the caller has a single place to pass it instead of two call
 * sites that must be kept in agreement by convention. Threading the flag to one
 * window and not the other is no longer expressible.
 */
export function computeSummaryAggregatePair(
  currentComponents: readonly AgentComponent[],
  previousComponents: readonly AgentComponent[] | undefined,
  dedupePluginRollups: boolean
): { current: SummaryAggregate; previous: SummaryAggregate | undefined } {
  return {
    current: computeSummaryAggregate(currentComponents, dedupePluginRollups),
    previous: previousComponents
      ? computeSummaryAggregate(previousComponents, dedupePluginRollups)
      : undefined,
  };
}

/**
 * ISS-6182 — the Invocations reduction AND the sentence the card uses to explain
 * itself, selected together by the one `dedupePluginRollups` gate.
 *
 * They used to be chosen in two places: the ternary in
 * {@link computeSummaryAggregate}, and a literal explainer in the card. So on
 * exactly the path the ISS-5534 flag ships, the card still promised a plain
 * per-component sum beside a number that deliberately DROPS every represented
 * plugin rollup. Picking both from this one table is what keeps the stated
 * method and the number it sits beside in agreement.
 */
const INVOCATIONS_DERIVATION = {
  deduped: {
    reduce: sumDedupedInvocations,
    // The sentence states the trigger {@link rollupIsAlreadyRepresented} really
    // tests — "any component that COULD belong to it" — not the stronger
    // "already represented", which this reduction cannot promise in either of
    // its two branches (wongk review on #5038). On the `packIds` branch one
    // in-view same-pack child drops the plugin's WHOLE rollup, including
    // filtered-out siblings that nothing in view represents; on the version-skew
    // branch a plugin with no `packIds` is dropped whenever any child-kind row
    // is present, related or not. Both under-count, so the copy names
    // under-counting as the trade rather than claiming a representation the
    // reduction never verified.
    how: "Sum of each in-view component's recorded invocations. A plugin's total is the sum of its components, so the plugin's whole total is excluded once any component that could belong to it is in view — a filter hiding the rest undercounts that plugin rather than double-counting it. The time window scopes which components are counted.",
  },
  flat: {
    reduce: (components: readonly AgentComponent[]) =>
      components.reduce((sum, c) => sum + (c.invocations ?? 0), 0),
    how: "Sum of each in-view component's recorded invocations (per-component totals; the time window scopes which components are counted).",
  },
} as const;

/**
 * How the Invocations summary card derives its number under the ISS-5534 gate,
 * and how it must describe that derivation to the reader.
 *
 * The card reads `how` from here instead of restating the method in its own
 * copy; a caller that hardcodes the sentence reintroduces the ISS-6182 drift.
 */
export function invocationsDerivation(dedupePluginRollups: boolean): {
  reduce: (components: readonly AgentComponent[]) => number;
  how: string;
} {
  return dedupePluginRollups
    ? INVOCATIONS_DERIVATION.deduped
    : INVOCATIONS_DERIVATION.flat;
}
