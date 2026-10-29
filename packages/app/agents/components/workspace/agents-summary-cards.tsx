"use client";

import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import {
  INVOCATIONS_DELTA_NOT_COMPARABLE,
  invocationsDerivation,
  isInvocationsComparable,
  type SummaryAggregate,
} from "@repo/api/src/utils/agent-component-summary-aggregate";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { useMetricCardHideUnavailable } from "@repo/app/shared/feature-flags/use-metric-card-hide-unavailable";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import {
  formatLocPerDollar,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import {
  partialStripCardClass,
  SUMMARY_CARD_SURFACE_BAND_PROPS,
  SummaryCardRow,
} from "../../../shared/components/summary-card-row";
import { NUMBER_FORMAT } from "../../lib/component-meta";

/**
 * Agents list summary cards (FEA-3178), extracted from `agents-grouped-list.tsx`
 * by ISS-6822.
 *
 * The extraction is what let the cards stop depending on rows. They previously
 * took the full filtered population and the full preceding population and
 * reduced both here, which meant the list had to HAVE both populations in the
 * browser. They now take the two aggregates, so the reduction can happen
 * wherever the population already is — in the renderer on the legacy path, at
 * the producer on the bounded one — and this component renders the same cards
 * from the same numbers either way.
 *
 * Whole-percent rounding factor for the period-over-period delta chip (the
 * MetricCard chip renders `{delta}%` as an integer with a leading `+`).
 */
const PERCENT = 100;

/**
 * FEA-3178: signed integer percentage change from `previous` → `current`,
 * rounded to a whole percent. Returns `undefined` — meaning "render no delta
 * chip" — whenever a percentage would be meaningless or misleading:
 *
 *  - `previous` is undefined (the "All" window has no prior period, or the
 *    preceding query has not resolved), or
 *  - the prior aggregate is 0 (division by zero — a jump from nothing to
 *    something is not a defensible "N%").
 *
 * This never fabricates a delta: an absent or empty baseline yields no chip,
 * never a placeholder number.
 */
function percentDelta(
  current: number,
  previous: number | undefined
): number | undefined {
  if (previous === undefined || previous === 0) {
    return undefined;
  }
  return Math.round(((current - previous) / previous) * PERCENT);
}

/**
 * ISS-5517: the three cards that render over EVERY population, hoisted so the
 * settled strip and the unsettled one below name the same metrics with the same
 * words. A second copy of these labels is how the loading strip would come to
 * announce a card the settled strip no longer has.
 *
 * The LOC/$ card is deliberately absent: it renders only when the population has
 * a verifiable-kind component (`hasVerifiableLocPerDollar`), which is not known
 * until the population is. Reserving a slot for it here would assert a fourth
 * card that may never arrive — the same fabrication in layout that the zeros
 * were in text.
 */
const COMPONENTS_CARD = {
  label: "Components",
  info: {
    what: "Agents, commands, and skills in the current view.",
    how: "Count of components in the active filter set.",
  },
} as const;

const INVOCATIONS_CARD_LABEL = "Invocations";

/**
 * The Invocations explainer for the UNSETTLED strip. The settled card reads its
 * copy from `invocationsDerivation(...).explain(current.invocationsExact)`,
 * which describes how THIS population was counted — a sentence there is nothing
 * to say yet when the population failed to load. This is the metric's plain
 * meaning, which is true whether or not the count arrived.
 */
const INVOCATIONS_CARD_INFO = {
  what: "Invocations of the components in the current view.",
  how: "Sum of each in-view component's recorded invocations.",
} as const;

const AUTHORS_CARD = {
  label: AGENT_COMPONENT_AUTHORS_LABEL,
  info: {
    what: "Distinct authors of components in the current view.",
    how: "Unique discoverer or editor across every visible component's version lineage.",
  },
} as const;

/** The three cards the unsettled strip renders, in the settled strip's order. */
const UNSETTLED_CARDS = [
  COMPONENTS_CARD,
  { label: INVOCATIONS_CARD_LABEL, info: INVOCATIONS_CARD_INFO },
  AUTHORS_CARD,
] as const;

/** The caption a card carries while its population is still being fetched. */
const LOADING_DETAIL = "Loading…";

/** The caption a card carries when the population could not be fetched at all. */
const UNAVAILABLE_DETAIL = "Unavailable";

export type AgentsSummaryCardsProps = {
  /**
   * ISS-5534: whether the Invocations total de-duplicates plugin rollups against
   * the child rows they were rolled up from. Resolved once by the list (PostHog
   * on web, Labs on desktop) and threaded in, so the CURRENT and PRECEDING
   * windows are always aggregated under the same rule — a delta computed from a
   * deduped current against a flat baseline would be meaningless. It reaches
   * this component only to pick the EXPLAINER copy; the reduction it names has
   * already been applied to `current`/`previous`.
   */
  dedupePluginRollups: boolean;
  /**
   * The aggregate over the FULL filtered population across ALL pages — never
   * the visible page slice. The headline stats (Components / Invocations /
   * LOC-per-$ / Authors) must describe the entire filtered set so they do not
   * change as the viewer pages through the list.
   */
  current: SummaryAggregate;
  /**
   * FEA-3178: the PRECEDING equivalent window's aggregate, reduced from a
   * population narrowed by the SAME facet filters so the delta compares
   * like-for-like. `undefined` when there is no meaningful prior period — the
   * "All" window, a data source that does not honor the date window (showing a
   * fabricated 0% would be misleading), or the baseline has not resolved — in
   * which cases no delta chips render.
   */
  previous?: SummaryAggregate;
  /**
   * Human caption for the delta chip, e.g. "vs prev 30 days". Only used when a
   * delta actually renders.
   */
  deltaLabel?: string;
  /**
   * ISS-5517: the inventory read's own load state. `current` is the honest
   * aggregate over an EMPTY population in this state, so every count in it is a
   * real `0` — which is exactly the value that must not reach a card, because
   * the population it is claimed over has not been fetched.
   */
  isLoading: boolean;
  /**
   * ISS-5517: the inventory read FAILED. `current` is the same empty aggregate,
   * so the same `0`s are in hand — this time meaning "we could not count", which
   * is a different sentence from "we counted none" and gets a different card.
   */
  isError: boolean;
};

export function AgentsSummaryCards({
  current,
  previous,
  deltaLabel,
  dedupePluginRollups,
  isLoading,
  isError,
}: AgentsSummaryCardsProps) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  // ISS-9749 (ISS-4779 closed-by-default), read beside the other gates.
  const hideUnavailable = useMetricCardHideUnavailable();

  const invocationsExplainer = invocationsDerivation(
    dedupePluginRollups
  ).explain(current.invocationsExact);
  // A delta is only meaningful when BOTH windows were counted the same way.
  // Exactness is a property of each window's DATA (a legacy plugin can be in one
  // window and not the other), so a mixed pair would report the change in
  // COUNTING METHOD as a change in usage — the drift FEA-3178 exists to stop.
  // The comparison lives in the reduction's own module because exactness alone
  // does not settle it: two exact windows can still have dropped and counted the
  // same plugin's rollup respectively (whitlockk review).
  const invocationsComparable = isInvocationsComparable(current, previous);
  const invocationsDelta = invocationsComparable
    ? percentDelta(current.invocations, previous?.invocations)
    : undefined;
  // Only when a prior window actually EXISTS. With none (the "All" range) there
  // was no comparison to withhold, and claiming one was withheld would be its
  // own small lie.
  const invocationsDeltaPlaceholder =
    previous !== undefined && !invocationsComparable
      ? INVOCATIONS_DELTA_NOT_COMPARABLE
      : undefined;

  // ISS-5517: while the population is unfetched or unreachable there is nothing
  // to count, so the strip says so instead of printing the empty aggregate's
  // zeros under captions that claim the filter set. Branch on the whole shape
  // rather than dressing individual cards: a strip that mixes a measured value
  // with an unmeasured one is the contradiction this ticket is about.
  //
  // Unconditional, because `NON_POPULATION_STATES` bars both states from
  // rendering as a zero at all: there is no reader for whom the confident zero
  // is the correct screen, so there is nothing for a gate to select between.
  if (isLoading || isError) {
    return <UnsettledSummaryCards failed={isError} />;
  }

  const cards = [
    {
      key: "components",
      label: COMPONENTS_CARD.label,
      value: NUMBER_FORMAT.format(current.components),
      delta: percentDelta(current.components, previous?.components),
      detail: "matched by the current filters",
      info: COMPONENTS_CARD.info,
    },
    {
      key: "invocations",
      label: INVOCATIONS_CARD_LABEL,
      // ISS-6205: the value stays a plain number in BOTH states. A `~` prefix
      // was tried and rejected in design review: on this surface `~` means "the
      // digits were abbreviated to fit, exact value one hover away" (the session
      // timeline rail), whereas this error is one-directional and unbounded, so
      // the glyph would make a total that could be badly high read as merely
      // rounded — and a screen reader does not speak it at all. The caveat is
      // carried in `detail`/`info` as words instead.
      value: NUMBER_FORMAT.format(current.invocations),
      delta: invocationsDelta,
      // Never an empty slot: the sibling cards keep their chips, so a hole here
      // would read as "no change" rather than "we did not compare".
      deltaPlaceholder: invocationsDeltaPlaceholder,
      // ISS-6182: read the copy from the same gate that picks the reduction, so
      // the card can never describe a derivation it no longer runs. ISS-6205:
      // and pass the reduction's own exactness, so the caption and the sentence
      // track whether THIS population's number was measured rather than being
      // chosen a second time here.
      detail: invocationsExplainer.detail,
      info: invocationsExplainer,
    },
    // FEA-4052: the LOC/$ card renders ONLY when the population has at least
    // one verifiable-kind component (currently only `subagent`; skill/command
    // are session-level, not component-level, so they are excluded — whitlockk, PR
    // #3720). A view built solely of non-verifiable kinds (skill/command/plugin/
    // mcp/tool/…) hides the card in lockstep with the hidden column, so the
    // summary never shows a LOC/$ card over a table with no LOC/$ column (or a
    // fabricated `0.0`).
    ...(current.hasVerifiableLocPerDollar
      ? [
          {
            key: LOC_PER_DOLLAR_CARD_KEY,
            label:
              LOC_METRIC_DEFINITION[LocMetricDefinitionId.ComponentLinesChanged]
                .label,
            value: formatLocPerDollar(current.locPerDollar),
            delta:
              current.locPerDollar === null
                ? undefined
                : percentDelta(
                    current.locPerDollar,
                    previous?.locPerDollar ?? undefined
                  ),
            // ISS-6409: "across", not "avg across". The figure is now total
            // lines over total cost, not a mean of the rows, and the old wording
            // described the statistic this card no longer computes.
            detail: `across ${NUMBER_FORMAT.format(current.locPerDollarSampleSize)} ${
              current.locPerDollarSampleSize === 1 ? "component" : "components"
            }`,
            info: {
              // ISS-5366: "changed", not "merged". This reads the same
              // non-merge-scoped `locPerDollar` the Metric column renders (see
              // POLISHED_METRIC_HEADER in agents-table.tsx); only the Sessions
              // card's `mergedLocPerDollar` earns the word "merged".
              what: "Total lines changed per total dollar across these components. Higher is better.",
              // ISS-6409: says which of the two shapes this is, because the same
              // "LOC / $" label sits on the Sessions and Branches cards and a
              // reader has no other way to know they are now comparable.
              how: "A ratio of totals, not an average of each component's rate, so a cheap component cannot swing it. Read it as directional.",
            },
          },
        ]
      : []),
    {
      key: "collaborators",
      label: AUTHORS_CARD.label,
      value: NUMBER_FORMAT.format(current.collaborators),
      delta: percentDelta(current.collaborators, previous?.collaborators),
      detail: "authoring components in view",
      info: AUTHORS_CARD.info,
    },
  ];

  // ISS-9749: the decision is taken HERE rather than by handing `MetricCard` a
  // `hideWhenUnavailable`, because every card on this strip carries a
  // pre-formatted non-null string — `formatLocPerDollar` returns `KPI_NO_VALUE`
  // for an absent ratio — so the primitive's own nullish check never fires.
  const candidates = cards.map((card) => ({
    id: card.key,
    notComputable:
      card.key === LOC_PER_DOLLAR_CARD_KEY && current.locPerDollar == null,
  }));
  const hidden = hiddenMetricCardIds({
    cards: candidates,
    enabled: hideUnavailable,
  });
  const cardClassName = partialStripCardClass({
    anyCardHidden: hidden.size > 0,
    cardClassName: BAND_CARD_CLASS,
    wrapBelow: BAND_ROW_PROPS.wrapBelow,
  });

  // FEA-3985 kept every card reachable at any width; ISS-9282 keeps the TABLE
  // reachable too. See `BAND_ROW_PROPS` for why this strip is one rank.
  return (
    <SummaryCardRow {...BAND_ROW_PROPS}>
      {cards
        .filter((card) => !hidden.has(card.key))
        .map((card) => {
          const commonProps = {
            className: cardClassName,
            detail: card.detail,
            // Only the Invocations card can withhold a comparison it was asked
            // for (ISS-6205); the rest never carry this key, so narrow rather than
            // spreading an `undefined` placeholder across every card.
            deltaPlaceholder:
              "deltaPlaceholder" in card ? card.deltaPlaceholder : undefined,
            info: card.info,
            label: card.label,
            value: card.value,
          };
          // `delta`/`deltaPolarity` are a paired union on MetricCard (whitlockk review
          // on #4148): these are all activity counts (sessions, PRs, components,
          // authors) where a rise is the product working, so they declare
          // higher-is-better explicitly alongside a real number; an absent delta
          // renders no chip.
          if (card.delta === undefined) {
            return <MetricCard key={card.key} {...commonProps} />;
          }
          return (
            <MetricCard
              key={card.key}
              {...commonProps}
              delta={card.delta}
              deltaLabel={deltaLabel}
              deltaPolarity={MetricPolarity.HigherIsBetter}
              deltaTreatment={deltaTreatment}
            />
          );
        })}
    </SummaryCardRow>
  );
}

/**
 * ISS-5517: the Agents summary strip over a population that has not been counted
 * — either not fetched yet (`failed: false`) or unreachable (`failed: true`).
 *
 * Both states hold the SAME empty aggregate, so both were rendering `0` under
 * captions ("matched by the current filters") that assert the number describes
 * the active filter set. It never did: on the error path those zeros sat
 * directly above "Couldn't load components", and on first paint above the
 * table's own "Loading components…". Three cards claiming a measurement while
 * the region below them says the measurement has not happened.
 *
 * The two states get DIFFERENT cards because they are different facts. Loading
 * skeletons the value slot (`MetricCard loading`) and marks the row `aria-busy`
 * — the number is coming. Failure shows the shared no-value glyph at the card's
 * own full opacity, exactly as the Sessions strip renders a failed read: the
 * `muted` prop is deliberately NOT used, because its `opacity-50` lands on the
 * whole card and takes an already-muted caption below the 4.5:1 the reader needs
 * most in the one state that asks them to act (WCAG 2.2 SC 1.4.3). `MetricCard`
 * softens the VALUE for a no-data card by itself; that is the whole treatment.
 *
 * ISS-9749 ruled this row OUT of `metric-card-hide-unavailable` on the strength
 * of that same paragraph. The settled cards always carry a counted number, so
 * the only nullish cards this file renders are the two below — and the FAILED
 * one deliberately omits `muted`, which is exactly the signal `MetricCard`'s
 * hide guard reads to protect a failed read. Opening the gate here would delete
 * the unreachable-population strip and leave the reader nothing above the
 * "Couldn't load components" region. The WCAG trade above is worth keeping; the
 * hide is not worth breaking it for.
 *
 * The LABEL is stated as fact in both states — it is known before the read. The
 * explainer is not, and that is the one place the two states differ: while
 * LOADING there is no derivation to describe (matching `SessionsSummaryCardsLoading`,
 * the sibling loading shell), but a FAILED read has not changed what the metric
 * MEANS, only whether its number arrived, so the popover stays.
 */
function UnsettledSummaryCards({ failed }: { failed: boolean }) {
  const detail = failed ? UNAVAILABLE_DETAIL : LOADING_DETAIL;
  // `busy` only on the LOADING branch — `aria-busy` announces a region whose
  // content is still arriving, which is exactly false once the read has failed
  // and nothing more is coming. The sibling strip is unconditionally busy
  // because it only ever renders while loading.
  return (
    <SummaryCardRow busy={!failed} {...BAND_ROW_PROPS}>
      {UNSETTLED_CARDS.map((card) => (
        <MetricCard
          className={BAND_CARD_CLASS}
          detail={detail}
          // A failed read still knows what the METRIC means — only the number
          // is missing — so the explainer stays. While loading it does not: it
          // describes a derivation that has not run, which is why the sibling
          // loading shell carries no `info` either.
          info={failed ? card.info : undefined}
          key={card.label}
          label={card.label}
          loading={!failed}
          value={null}
          valueUnavailableLabel={KPI_NO_VALUE}
        />
      ))}
    </SummaryCardRow>
  );
}

/**
 * ISS-9282: this strip takes the one shared metric-band treatment
 * (`SUMMARY_CARD_SURFACE_BAND_PROPS`, ISS-11472) instead of its own `wrapBelow`
 * grid, so Agents lays its cards out the way Sessions and Branches already do.
 *
 * The grid paired the cards two-up below `md`, so the strip's four cards (three
 * when ISS-9749 retires LOC / $) took two ranks (316px measured at 390px wide).
 * With the honesty gate on, `AgentsListSurfaceV2` pins this strip `shrink-0`
 * above the table's `min-h-0 flex-1` scroll region, so every rank the strip
 * gained came out of the table. One rank that scrolls sideways inside its own
 * band keeps every card reachable without spending the table, which is the
 * decision ISS-10314 took for the other two bands. That is sufficient on its
 * own here: the strip's height is one card's, so no height ceiling is added to
 * the host.
 *
 * `cardClassName` is split off because `SummaryCardRow` sizes the row, not its
 * cards; the cards are this file's `MetricCard`s.
 */
const { cardClassName: BAND_CARD_CLASS, ...BAND_ROW_PROPS } =
  SUMMARY_CARD_SURFACE_BAND_PROPS;

/** The settled strip's LOC/$ card, the one card ISS-9749's gate can retire. */
const LOC_PER_DOLLAR_CARD_KEY = "loc-per-dollar";
