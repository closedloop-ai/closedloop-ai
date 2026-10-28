/**
 * Agents list summary-card aggregation (ISS-5534).
 *
 * Extracted out of the 1,100-line `agents-grouped-list.tsx` so the four headline
 * aggregates have a lightweight, component-free test target — and so the
 * Invocations de-duplication below can be exercised directly rather than only
 * through a full render.
 *
 * ISS-6822 relocated it from `packages/app/agents/lib/` into `@repo/api` — with
 * its explainer copy, deliberately: ISS-6182 put the reduction and the sentence
 * that describes it in one table precisely so they cannot drift, and splitting
 * them across packages to keep copy out of this one would reopen that. The move
 * is what lets the SERVER reduce the same population with the same code and
 * return a compact aggregate instead of shipping the whole inventory to the
 * browser to reduce it there. No logic changed in the move.
 *
 * FEA-3178: the current and PRECEDING windows are aggregated by this identical
 * reduction, so the delta chips can never drift between the two populations.
 */

import {
  type AgentComponent,
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
  PLUGIN_CHILD_KIND_SET,
} from "../types/agent-component.ts";

/**
 * FEA-3178: the four headline aggregates the summary cards display, computed
 * over a population of components. LOC/$ is the average of the non-null
 * per-component ratios.
 */
export type SummaryAggregate = {
  components: number;
  invocations: number;
  /**
   * ISS-6409: the population's LOC/$ as a ratio of sums — total lines changed
   * over total cost, folded across the UNION of the population's sessions.
   *
   * Supplied by the producer, not derived from the rows, and `null` when no
   * producer supplied it. That is a correctness constraint, not a layering
   * preference: one session can invoke several subagents, and each component's
   * own terms count that session's full LOC and cost, so summing per-row terms
   * weights a shared session once per component that used it. The result is
   * neither the union's rate nor the Sessions/Branches cards' — a third
   * estimand, which is what this issue exists to eliminate (#6417 review).
   * Only a fold that can see session identities gets this right, so it happens
   * where those identities still exist.
   *
   * This replaced an unweighted mean of the per-component ratios (FEA-4052).
   * That mean asserted every component's cost was equal and had no denominator
   * floor, so a component that ran once on a $0.02 session contributed a
   * 2,500 LOC/$ sample on equal footing with one that consumed the budget — on
   * the issue's worked example it read ~1,070 where the real rate was ~30.
   * Cosimo ruled on 2026-09-01 that the metric is a ratio of sums on every
   * surface, and on 2026-09-01 that the population is the session union.
   *
   * `null` is kept distinct from a real `0` so the card renders `—` rather than
   * a fabricated `0.0`.
   */
  locPerDollar: number | null;
  /**
   * ISS-6409: how many components the figure was folded OVER — verifiable
   * kind, contributing at least one session that carried lines or cost. Zero
   * whenever `locPerDollar` is null, so the two fields cannot contradict.
   *
   * This SUPERSEDES the earlier rule, which counted only components carrying
   * their own measurable ratio and named the same population a row's non-null
   * `locPerDollar` does (FEA-4052 / ISS-5005). That rule belonged to a mean of
   * ratios, where each component WAS a sample. A ratio of sums has no
   * per-component sample to count, and keeping the old rule let the two fields
   * disagree in both directions: it understated systematically (500 components
   * in the union, "across 23" underneath), and it was reachable outright — one
   * component with lines but no priced spend and one with spend but no lines
   * each fold to null, so neither was counted while the union carried both
   * terms and rendered a real number above "across 0 components".
   *
   * The user-visible effect is a LARGER stated sample than ISS-5005 described.
   * That is intended: the disclosure now names the population that fed the
   * sums, which is what the figure actually describes (#6417 review).
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
  /**
   * ISS-6205: whether {@link invocations} is an EXACT total or a known
   * undercount.
   *
   * False only on the de-duplicated path, and only when the population BOTH
   * holds a plugin whose parentage the producer could not report (no `packIds`)
   * AND holds at least one child-kind row that actually contributed usage. The
   * canonical `AgentComponent.packIds` contract requires that rollup be dropped
   * — the documented population-wide fallback, which may under-count — so the
   * figure can be missing that plugin's calls and the card must announce it
   * instead of presenting it as measured.
   *
   * Always true on the flag-off flat sum: that path de-duplicates nothing, so
   * there is no parentage question to be unsure about.
   */
  invocationsExact: boolean;
  /**
   * ISS-6205 (whitlockk review): which coverage answer each plugin row in this
   * population got, keyed by its org-level {@link AgentComponent.slug}.
   *
   * Carried out of the reduction so a CURRENT/PRECEDING pair can be checked for
   * comparability by {@link isInvocationsComparable}. Exactness alone cannot do
   * it: both windows can be exact while the same plugin was dropped in one and
   * counted in the other.
   */
  invocationsPluginCoverage: ReadonlyMap<string, PluginRollupCoverage>;
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
 * producers now emit (ISS-5534, whitlockk review on #4902). When a plugin's children
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
 * SKEW (ISS-6205). `packIds` is additive and optional, so a producer that
 * predates it omits it everywhere. The PLUGIN row is the probe: a plugin with no
 * `packIds` has parentage this reader CANNOT KNOW. The canonical contract
 * (`AgentComponent.packIds`, `packages/api/src/types/agent-component.ts`) says
 * what a reader owes that case, in as many words: degrade "to a population-wide
 * heuristic (which may under-count) rather than to an over-count". So the rollup
 * is DROPPED, not counted — a version-skewed producer must never be able to push
 * this card above the truth.
 *
 * What ISS-6205 fixes is the SILENCE, not the direction. The old reader dropped
 * that rollup and published the result as a plain measured number, so one
 * unrelated child row anywhere in the view discarded a legacy plugin's entire
 * usage with nothing on screen to distinguish the result from an exact
 * aggregate. The drop now sets {@link InvocationsTotal.exact} to false and the
 * card says the calls may be missing. An absent `packIds` on a CHILD row from a
 * producer that did populate the plugin's is a different and honest answer: a
 * component belonging to no pack, so not one of this plugin's children.
 *
 * Unknown parentage is only a reason to DOUBT the total, never on its own a
 * reason to disclaim one — and never on its own a reason to drop a rollup. The
 * fallback needs something the rollup could actually be double-counting, which
 * is a child-kind row that CONTRIBUTED usage:
 *
 *  - no child-kind row at all (the Plugins type tab, or a facet that excluded
 *    every child): the rollup is the only record of that activity, so it is
 *    counted and the total is exact.
 *  - child-kind rows present but every one of them at zero (whitlockk review): a
 *    windowed query returns rows for the components that had usage, so children
 *    sitting at zero contributed nothing the plugin's rollup could restate.
 *    Dropping it would be a pure loss against no overlap, so it is counted and
 *    the total is exact.
 *
 * The mirror of that second case is a legacy plugin at zero beside contributing
 * children: the fallback drops a rollup worth nothing, so nothing is missing and
 * the total is likewise exact. Both directions are pinned in
 * `__tests__/agents-summary-aggregate.test.ts`.
 */
export function sumDedupedInvocations(
  components: readonly AgentComponent[]
): InvocationsTotal {
  const representedPackIds = new Set<string>();
  let hasContributingChildRow = false;
  for (const component of components) {
    if (!PLUGIN_CHILD_KIND_SET.has(component.kind)) {
      continue;
    }
    if ((component.invocations ?? 0) > 0) {
      hasContributingChildRow = true;
    }
    for (const packId of component.packIds ?? []) {
      representedPackIds.add(packId);
    }
  }

  let invocations = 0;
  let exact = true;
  const pluginCoverage = new Map<string, PluginRollupCoverage>();
  for (const component of components) {
    if (component.kind !== AgentComponentKind.Plugin) {
      invocations += component.invocations ?? 0;
      continue;
    }
    const coverage = pluginRollupCoverage(
      component,
      representedPackIds,
      hasContributingChildRow
    );
    pluginCoverage.set(component.slug, coverage);
    const effect = COVERAGE_EFFECT[coverage];
    const rollup = component.invocations ?? 0;
    if (effect.counted) {
      invocations += rollup;
    }
    // A dropped rollup can only have COST the total what it actually carried. A
    // windowed query returns 0/null invocations for a plugin whose children had
    // no in-window usage, and dropping nothing has provably lost nothing — so it
    // must not cost the total its exactness.
    if (!effect.exactWhenApplied && rollup > 0) {
      exact = false;
    }
  }
  return { exact, invocations, pluginCoverage };
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
  dedupePluginRollups = false,
  foldLocPerDollar?: LocPerDollarFold
): SummaryAggregate {
  const invocations =
    invocationsDerivation(dedupePluginRollups).reduce(components);
  const locPerDollarFold = foldLocPerDollar?.(components) ?? {
    locPerDollar: null,
    sampleSize: 0,
  };
  const collaborators = new Set(components.flatMap((c) => c.collaborators))
    .size;
  return {
    components: components.length,
    invocations: invocations.invocations,
    locPerDollar: locPerDollarFold.locPerDollar,
    locPerDollarSampleSize: locPerDollarFold.sampleSize,
    collaborators,
    hasVerifiableLocPerDollar: components.some((c) =>
      isLocPerDollarVerifiableKind(c.kind)
    ),
    invocationsExact: invocations.exact,
    invocationsPluginCoverage: invocations.pluginCoverage,
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
  dedupePluginRollups: boolean,
  folds?: LocPerDollarFoldPair
): { current: SummaryAggregate; previous: SummaryAggregate | undefined } {
  return {
    current: computeSummaryAggregate(
      currentComponents,
      dedupePluginRollups,
      folds?.current
    ),
    previous: previousComponents
      ? computeSummaryAggregate(
          previousComponents,
          dedupePluginRollups,
          folds?.previous
        )
      : undefined,
  };
}

/**
 * A producer's LOC/$ fold over one population, run AFTER filtering so the
 * figure describes the rows the card sits above.
 *
 * Only a caller that still holds session identities can implement this — the
 * cloud page-data service and the desktop local reader. The browser's legacy
 * client-side reduction passes nothing and the card reads `—`, which is the
 * honest answer there: from rows alone the union is not recoverable, and the
 * available per-row terms would produce a differently-weighted number under a
 * label that promises comparability with the Sessions and Branches cards.
 */
export type LocPerDollarFold = (components: readonly AgentComponent[]) => {
  locPerDollar: number | null;
  sampleSize: number;
};

/**
 * ISS-6409 (#6417 review): one fold PER WINDOW.
 *
 * A fold closes over the session maps of the population it was built from, so
 * a single closure cannot answer for two windows: applied to the preceding
 * window it would re-fold the CURRENT window's sessions, silently dropping any
 * component the current window lacks and reporting a delta against itself.
 *
 * Separate fields make that HARDER to write, not impossible — `{current: f,
 * previous: f}` still type-checks, as does a `previous` population with no
 * `previous` fold (which yields `null` and drops the delta chip). What the
 * split buys is that the mistake now has to be typed out deliberately instead
 * of being the only thing the signature allowed. The binding of a population
 * to its own fold is still call-site discipline; `readPopulationWithFold`
 * returns the two together so the call sites keep it.
 */
export type LocPerDollarFoldPair = {
  current?: LocPerDollarFold;
  previous?: LocPerDollarFold;
};

/**
 * ISS-6205: how a plugin row's rolled-up total relates to the child rows in the
 * same population — the three-way answer that replaced a boolean.
 *
 * The boolean could only say "already represented" or "not", and the version-skew
 * case is neither: it is a question this reader cannot answer at all. Collapsing
 * it into "represented" is what silently discarded a legacy plugin's invocations.
 */
export const PluginRollupCoverage = {
  /** This plugin's own children are in the population; counting it double-counts. */
  Represented: "represented",
  /** No child of this plugin is in view, so its rollup is the only record of that usage. */
  Independent: "independent",
  /**
   * The producer reported no parentage while contributing child rows are in
   * view, so representation is unknowable and the documented fallback applies.
   */
  Unknown: "unknown",
} as const;
export type PluginRollupCoverage =
  (typeof PluginRollupCoverage)[keyof typeof PluginRollupCoverage];

/**
 * ISS-6205: what each coverage answer means for the reduction — whether the
 * rollup is COUNTED, and whether applying that answer costs the total its
 * exactness.
 *
 * An exhaustive `Record` rather than a chain of `if`s so a fourth coverage state
 * fails `tsc` here instead of silently inheriting the fall-through it happens to
 * land on ("drop it, and still call the result exact") — which is precisely the
 * collapse-into-the-nearest-state defect ISS-6205 exists to fix.
 *
 * `Unknown` drops like `Represented` — the contract's under-count-not-over-count
 * fallback — but unlike `Represented` it cannot promise the dropped calls were
 * counted anywhere else, so it is the one answer that publishes doubt.
 */
const COVERAGE_EFFECT: Record<
  PluginRollupCoverage,
  { counted: boolean; exactWhenApplied: boolean }
> = {
  [PluginRollupCoverage.Represented]: {
    counted: false,
    exactWhenApplied: true,
  },
  [PluginRollupCoverage.Independent]: { counted: true, exactWhenApplied: true },
  [PluginRollupCoverage.Unknown]: { counted: false, exactWhenApplied: false },
};

/**
 * ISS-6205: an invocations total together with whether it is EXACT and how each
 * plugin rollup in the population was treated.
 *
 * The three travel as one value so a reduction cannot hand back a number while
 * leaving its own confidence — or the provenance a window-to-window comparison
 * needs — for the caller to re-derive.
 */
export type InvocationsTotal = {
  invocations: number;
  exact: boolean;
  pluginCoverage: ReadonlyMap<string, PluginRollupCoverage>;
};

/**
 * Classify one plugin row against the packs the population's child rows belong to.
 *
 * When the producer emits `packIds` the answer is exact: the intersection of this
 * plugin's pack candidates with the packs those child rows actually belong to.
 *
 * When it does not, the canonical `AgentComponent.packIds` contract prescribes
 * the answer — degrade to the population-wide heuristic, which may under-count,
 * never to an over-count. That heuristic only has something to say when a
 * child-kind row actually CONTRIBUTED usage this rollup could be restating; with
 * none, there is nothing to under-count against and the rollup is the sole
 * record of that activity.
 */
function pluginRollupCoverage(
  plugin: AgentComponent,
  representedPackIds: ReadonlySet<string>,
  hasContributingChildRow: boolean
): PluginRollupCoverage {
  const packIds = plugin.packIds;
  if (packIds === undefined) {
    return hasContributingChildRow
      ? PluginRollupCoverage.Unknown
      : PluginRollupCoverage.Independent;
  }
  return packIds.some((packId) => representedPackIds.has(packId))
    ? PluginRollupCoverage.Represented
    : PluginRollupCoverage.Independent;
}

const INVOCATIONS_WHAT_EXACT =
  "Total tool calls attributed to these components.";

/** The card's default `detail` caption — it names the population, not a caveat. */
const INVOCATIONS_DETAIL_EXACT = "across components in view";

/**
 * ISS-6182 — the Invocations reduction AND the sentences the card uses to
 * explain itself, selected together by the one `dedupePluginRollups` gate.
 *
 * They used to be chosen in two places: the ternary in
 * {@link computeSummaryAggregate}, and a literal explainer in the card. So on
 * exactly the path the ISS-5534 flag ships, the card still promised a plain
 * per-component sum beside a number that deliberately DROPS every represented
 * plugin rollup. Picking both from this one table is what keeps the stated
 * method and the number it sits beside in agreement.
 *
 * ISS-6205 makes `explain` take the reduction's own `exact` flag, because the
 * de-duplicated path now has TWO honest descriptions and the number decides
 * which one is true. Hardcoding either at the call site is the same drift
 * ISS-6182 closed, so both live here.
 */
const INVOCATIONS_DERIVATION = {
  deduped: {
    reduce: sumDedupedInvocations,
    // The sentence states the trigger {@link pluginRollupCoverage} really
    // tests — "any component that COULD belong to it" — not the stronger
    // "already represented", which this reduction cannot promise (whitlockk review
    // on #5038): one in-view same-pack child drops the plugin's WHOLE rollup,
    // including filtered-out siblings that nothing in view represents. That
    // under-counts, so the copy names under-counting as the trade rather than
    // claiming a representation the reduction never verified.
    //
    // ISS-6205: this is the EXACT-path sentence only. The version-skew branch no
    // longer drops anything, so describing it as an exclusion would misstate the
    // very case that ticket fixed — it gets its own sentence below.
    explain: (exact: boolean) =>
      exact
        ? {
            what: INVOCATIONS_WHAT_EXACT,
            how: "Sum of each in-view component's recorded invocations. A plugin's total is the sum of its components, so the plugin's whole total is excluded once any component that could belong to it is in view — a filter hiding the rest undercounts that plugin rather than double-counting it. The time window scopes which components are counted.",
            detail: INVOCATIONS_DETAIL_EXACT,
          }
        : {
            what: INVOCATIONS_WHAT_EXACT,
            // ISS-6205 design review: ONE sentence, saying what we could not
            // tell and what it costs the number — not our implementation
            // history ("dropped rather than included") and not a hedge
            // ("approximate", "estimated"), which reads as a measured figure
            // with error bars. Same posture as the timeline's synthesized-cost
            // legend, which states what was NOT recorded.
            how: "Sum of each in-view component's recorded invocations. One plugin in view does not report which components belong to it, so its total is left out and some calls may be missing.",
            detail: "some calls may be missing",
          },
  },
  flat: {
    reduce: (components: readonly AgentComponent[]): InvocationsTotal => ({
      invocations: components.reduce((sum, c) => sum + (c.invocations ?? 0), 0),
      // The flat sum de-duplicates nothing, so it has no parentage question to
      // be unsure about — there is no second sentence for this branch to pick,
      // and no per-plugin decision for a window pair to disagree over.
      exact: true,
      pluginCoverage: EMPTY_PLUGIN_COVERAGE,
    }),
    explain: () => ({
      what: INVOCATIONS_WHAT_EXACT,
      how: "Sum of each in-view component's recorded invocations (per-component totals; the time window scopes which components are counted).",
      detail: INVOCATIONS_DETAIL_EXACT,
    }),
  },
} as const;

/**
 * ISS-6205 design review: what the card puts in the DELTA slot when it withheld
 * the comparison because the two windows were not counted the same way.
 *
 * The slot is filled rather than left empty for the reason
 * `sessions-summary-delta-slots` fills it: a hole beside three sibling cards
 * that DID compare reads as "no change", and the row's height moves. It also
 * closes the state the design review caught — a CURRENT window that is exact
 * beside an inexact PREVIOUS one renders a plain number and an exact-path
 * explainer, so without this the card would drop the comparison silently.
 */
export const INVOCATIONS_DELTA_NOT_COMPARABLE = "Not comparable";

/**
 * How the Invocations summary card derives its number under the ISS-5534 gate,
 * and how it must describe that derivation to the reader.
 *
 * The card reads its copy from `explain` instead of restating the method in its
 * own literals; a caller that hardcodes a sentence reintroduces the ISS-6182
 * drift, and after ISS-6205 it would also have to re-derive which of the two
 * de-duplicated sentences the number earned.
 */
export function invocationsDerivation(dedupePluginRollups: boolean): {
  reduce: (components: readonly AgentComponent[]) => InvocationsTotal;
  explain: (exact: boolean) => {
    what: string;
    how: string;
    /**
     * The caption under the value. Carries the inexactness in WORDS rather than
     * as a glyph, so it reaches the accessibility tree — ISS-5761 established
     * that a marker a screen reader does not speak is not a disclosure.
     */
    detail: string;
  };
} {
  return dedupePluginRollups
    ? INVOCATIONS_DERIVATION.deduped
    : INVOCATIONS_DERIVATION.flat;
}

/** The flat sum makes no per-plugin decision, so it has no provenance to carry. */
const EMPTY_PLUGIN_COVERAGE: ReadonlyMap<string, PluginRollupCoverage> =
  new Map();

/**
 * ISS-6205 (whitlockk review): whether a CURRENT/PRECEDING pair was counted the same
 * way, and so whether a percentage between them means anything.
 *
 * Matching exactness is necessary but NOT sufficient, which is the defect this
 * closes: both windows can be exact while the same plugin was treated
 * differently in each. A facet can leave a plugin plus one of its children in the
 * current window — the child represents the rollup, so it is dropped — while the
 * preceding window holds only the plugin because that child had no prior usage,
 * where the rollup is the sole record and is counted. Two exact numbers, two
 * different populations, and a percentage between them reports the change in
 * COUNTING METHOD as a change in usage.
 *
 * So the coverage answers themselves are compared, per plugin, by the org-level
 * slug that is stable across windows. A plugin present in only ONE window is not
 * a mismatch — that is a real population change, which is exactly what the delta
 * is for.
 */
export function isInvocationsComparable(
  current: SummaryAggregate,
  previous: SummaryAggregate | undefined
): boolean {
  if (previous === undefined) {
    return true;
  }
  if (!(current.invocationsExact && previous.invocationsExact)) {
    return false;
  }
  for (const [slug, coverage] of current.invocationsPluginCoverage) {
    const before = previous.invocationsPluginCoverage.get(slug);
    if (before !== undefined && before !== coverage) {
      return false;
    }
  }
  return true;
}
