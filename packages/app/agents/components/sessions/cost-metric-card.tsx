"use client";

// Sibling-slice import (agents → insights): the canonical KPI polarity registry,
// so the Cost card reads its lower-is-better verdict from the SAME declaration
// the Dashboard/Insights tiles route through instead of hardcoding a second copy
// that could silently drift from the catalog (ISS-4633, review on #4148).
import {
  InsightsKpiKey,
  KPI_METRIC_POLARITY,
} from "@repo/app/insights/lib/kpi-polarity";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import {
  formatCurrencyTileValue,
  formatCurrencyWhole,
  WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR,
  WHOLE_CURRENCY_BELOW_FLOOR,
} from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { MetricDeltaTreatment } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { ReactNode } from "react";

/**
 * Canonical label for the agent-spend "Cost" metric card. The Dashboard KPI row
 * renders this (its default). The Sessions summary row now passes its own
 * `SESSIONS_COST_METRIC_CARD_LABEL` instead — the two surfaces intentionally
 * carry different labels because they sum different bases (ISS-4401), so this is
 * no longer the string EVERY surface renders. Exported so the Dashboard row and
 * the tests share one string instead of re-declaring it. See FEA-3818.
 */
export const COST_METRIC_CARD_LABEL = "Cost";

/**
 * Info copy for the Sessions summary "Cost" card. The headline is
 * `apiEstimatedCost`: the spend NOT covered by a subscription or seat — the same
 * basis the LOC-per-dollar card divides by. Sessions billed to an API key land
 * here, and so do sessions whose billing source isn't known yet (legacy/null or
 * an unrecognized source), which the producer treats as not-subscription rather
 * than assuming they're covered (see the `unknown` fallback in
 * `agent-sessions/service.ts` and the desktop `shared-agent-sessions-api.ts`);
 * naming them "not covered by a subscription" keeps that basis truthful on both.
 *
 * ISS-6092: this copy is reworded into a plainer voice — `what` is a one-line
 * summary of the card, `how` carries the derivation and glosses the caption
 * beneath the number — but the BASIS both name is unchanged, and naming it is
 * not optional.
 *
 * The first draft of this rewording dropped the basis from both strings ("Cost
 * across the filtered sessions" / "Session cost is summed for the selected and
 * filtered range"). Codex review on #4905 rejected it, correctly: with the
 * honesty flag OFF — the default — `resolveCostCardPresentation` headlines
 * `apiEstimatedCost` alone, so on the canonical $30-API/$70-subscription cohort
 * the card shows `$30` while that copy described the cohort's whole cost. The
 * number was right and the words around it were not, which is exactly the
 * partial-figure-as-total conflation ISS-4401 exists to prevent. `what` and
 * `how` therefore both keep an explicit "not covered by a subscription"
 * qualifier; only the voice moved.
 *
 * `how` also glosses the caption COUNTERFACTUALLY ("would have cost if billed
 * to an API key"), matching the caption's own "if billed to API" tail. The two
 * strings must move together: a caption reworded out of the conditional, or a
 * gloss that drops it, reads the API-equivalent figure as money charged (the
 * FEA-4231 misreading, re-raised as the second codex P1 on #4905).
 *
 * FEA-3434 still governs the FORM: short, plain, and in the reader's words, with
 * no implementation jargon ("stored", "billing source", "denominator",
 * "subtext") and no claim of a query-time "tokens × model rate" recompute.
 *
 * ISS-4401 (wongk review) still governs the LABEL, which this ticket does NOT
 * change: `apiEstimatedCost` is NOT strictly API-key spend — both producers fold
 * sessions with an unknown/legacy-null billing source into it (desktop computes
 * it as `metered + unknown`, see `shared-agent-sessions-api.ts`), so an "API
 * Cost" label would present unclassified usage as confirmed API charges. Any
 * further movement on that label is owned by ISS-6021.
 */
export const SESSIONS_COST_METRIC_CARD_INFO = {
  what: "Cost across the filtered sessions not covered by a subscription.",
  how: "Session cost is summed for the selected and filtered range, counting only the sessions a subscription doesn't cover. The caption beneath estimates what the subscription-covered sessions would have cost if billed to an API key.",
} as const;

export type CostMetricCardProps = {
  /**
   * The dollar amount rendered as the card headline. A finite number (including
   * `0` — an honest zero for a set that cost nothing) formats as whole dollars;
   * `null`/`undefined`/non-finite renders the honest-empty `—` sentinel (the
   * metric is unavailable for the window, never a misleading `$0`), matching the
   * KPI-tile currency formatter.
   */
  cost: number | null | undefined;
  /**
   * Card label / accessible name. Defaults to `COST_METRIC_CARD_LABEL` ("Cost")
   * so the Dashboard KPI row and any other caller stay unchanged. The Sessions
   * summary passes `SESSIONS_COST_METRIC_CARD_LABEL` ("cost") so
   * its not-subscription-covered figure and the Dashboard's subscription-inclusive
   * "Cost" total read as two distinct metrics rather than the same word
   * disagreeing across screens (ISS-4401).
   */
  label?: string;
  /**
   * Info popover copy (what/how). Defaults to the Sessions metered-spend copy;
   * each surface passes info that stays truthful to its own value basis (e.g.
   * the Dashboard feeds the single-line backend `kpi.sub`, matching its rowmates
   * and the Insights stat tile so the cost metric reads one voice per screen).
   */
  info?: { what: string; how?: string };
  /** Detail line beneath the value (e.g. the subscription-inclusive total). */
  detail?: ReactNode;
  /**
   * Period-over-period change chip. A number renders the signed delta; omit for
   * surfaces (e.g. the Sessions summary row) that have no comparison endpoint.
   */
  delta?: number;
  /**
   * Marks the delta as clamped to the display ceiling (FEA-3959) so the chip
   * renders "+999%+" instead of an unbounded figure. Forwarded to the underlying
   * MetricCard; ignored when `delta` is omitted.
   */
  deltaCapped?: boolean;
  /** Caption beside the delta chip (e.g. "vs. prior 90 days"). */
  deltaLabel?: ReactNode;
  /** Recent values powering the delta chip's sparkline. */
  sparkline?: Array<number | null | undefined>;
  /**
   * "No comparison" affordance rendered in the delta slot when there's no
   * numeric `delta` for the range, so the delta info keeps a stable position
   * rather than dropping to a different footer corner. Forwarded to MetricCard's
   * `deltaPlaceholder`; ignored when `delta` is a number.
   */
  deltaPlaceholder?: ReactNode;
  /**
   * ISS-5842 (follow-up, review on #4907): the delta treatment the CALLING
   * surface resolved, when it has one.
   *
   * This card used to read `useMetricDeltaTreatment()` and nothing else, which
   * made it the live counterexample to the Sessions strip's "the slot bag
   * carries the treatment" guarantee: the strip spreads a `deltaSlotProps` bag
   * onto this component, JSX spreads are NOT excess-property checked, and this
   * component destructured explicit props — so the bag's `deltaTreatment` was
   * silently dropped on the floor. It happened to render correctly only because
   * the hook it called resolves the same flag.
   *
   * Declaring the prop makes the bag's value actually flow through, so the
   * strip has ONE source for the treatment rather than two that agree by
   * coincidence. It stays OPTIONAL because the org Dashboard KPI row
   * (`dashboard-rows.tsx`) renders this card without a slot bag; that caller
   * keeps the internally-resolved value, which is the same flag either way.
   */
  deltaTreatment?: MetricDeltaTreatment;
  /** Detail-row trend caption (distinct from the delta slot). */
  trend?: ReactNode;
  className?: string;
  /**
   * FEA-4128: skeleton ONLY the value slot while the cost is still hydrating,
   * keeping the card's label/info/detail chrome. Forwarded to MetricCard.
   */
  loading?: boolean;
};

/**
 * Shared "Cost" metric card. Single implementation of the agent-spend cost card
 * rendered on both the Sessions summary row and the org Dashboard KPI row, so
 * the two surfaces can't drift on formatting, label, the honest-empty `—`, or
 * the delta chip (FEA-3818). Each surface passes its own value + truthful info
 * copy (the two backends compute cost on different bases), but the presentation
 * is now one component.
 */
export function CostMetricCard({
  cost,
  label = COST_METRIC_CARD_LABEL,
  info = SESSIONS_COST_METRIC_CARD_INFO,
  detail,
  delta,
  deltaCapped,
  deltaLabel,
  sparkline,
  deltaPlaceholder,
  deltaTreatment: deltaTreatmentProp,
  trend,
  className,
  loading = false,
}: Readonly<CostMetricCardProps>) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  // The hook is called unconditionally (it is a hook) and used only as the
  // FALLBACK for a caller that resolved no treatment of its own — the org
  // Dashboard row. A caller that did resolve one (the Sessions strip, via its
  // `deltaSlotProps` bag) wins, so its whole row cannot split across two delta
  // families even if the two ever stopped reading the same flag.
  const surfaceDeltaTreatment = useMetricDeltaTreatment();
  const deltaTreatment = deltaTreatmentProp ?? surfaceDeltaTreatment;
  // Honest-empty: an unavailable metric renders `—` (never a misleading `$0`),
  // and a real `0` still reads as `$0`. Routed through the shared
  // `formatCurrencyTileValue` SSOT so this card and the insights KPI tiles apply
  // the identical null/finite guard + whole-dollar formatting.
  const value = formatCurrencyTileValue(cost);
  // ISS-5401 (design review): tell `MetricCard` the slot is EMPTY, not just what
  // string to paint in it. Handing it a pre-formatted `"—"` leaves `value`
  // non-null, so `noData` stays false and the dash renders at full foreground in
  // `font-semibold` — which `MetricCard`'s own contract calls out as wrong
  // ("never … a bold 2xl em-dash, which reads like a struck/rule value rather
  // than 'nothing to show'", FEA-4236). The GLYPH is unchanged; only the weight
  // and colour move, to the muted treatment the primitive already ships.
  const valueUnavailable = cost == null || !Number.isFinite(cost);

  // With a numeric delta the card MUST declare its polarity (the MetricCard
  // delta/polarity paired union — wongk review on #4148); without one it fills
  // the delta slot with the "No comparison" placeholder. Spend is lower-is-better,
  // read from the catalog SSOT so this card can't drift from the Dashboard/Insights
  // Cost tile (ISS-4633).
  if (delta === undefined) {
    return (
      <MetricCard
        className={className}
        deltaPlaceholder={deltaPlaceholder}
        detail={detail}
        info={info}
        label={label}
        loading={loading}
        trend={trend}
        value={value}
        valueUnavailable={valueUnavailable}
        valueUnavailableLabel={value}
      />
    );
  }

  return (
    <MetricCard
      className={className}
      delta={delta}
      deltaCapped={deltaCapped}
      deltaLabel={deltaLabel}
      deltaPolarity={KPI_METRIC_POLARITY[InsightsKpiKey.Cost]}
      deltaTreatment={deltaTreatment}
      detail={detail}
      info={info}
      label={label}
      loading={loading}
      sparkline={sparkline}
      trend={trend}
      value={value}
      valueUnavailable={valueUnavailable}
      valueUnavailableLabel={value}
    />
  );
}

/**
 * Detail-line copy for the Sessions Cost card. The rule, stated once: the "Cost"
 * headline is the out-of-pocket, not-subscription-covered spend (`apiEstimatedCost`);
 * this line names the API-EQUIVALENT of the subscription-covered usage — what it
 * WOULD have cost billed to an API key at model rates — and renders
 * "+$X if billed to API" (FEA-4231, wongk review).
 *
 * ISS-6092 briefly reworded this to "+$X est. API spend via subscription" and
 * codex review on #4905 rejected it as a P1: with `subscriptionEstimatedCost`
 * positive, that phrasing asserts API spend that a subscription user actually
 * incurred, when the figure is a price nobody was charged. "est." qualifies the
 * PRECISION of the number, not its reality, so it cannot carry the conditional
 * on its own. The conditional has to be in the grammar — "if" — which is what
 * the restored FEA-4231 wording does, in four words, in a ~124px card.
 * `SESSIONS_COST_METRIC_CARD_INFO.how` glosses the same line in the same mood
 * ("would have cost if billed to an API key"), so the two must move together.
 *
 * The share is read DIRECTLY from the canonical `subscriptionEstimatedCost` field
 * both producers carry, never recomputed as `totalEstimatedCost − apiEstimatedCost`:
 * since FEA-3986 the total is the subscription-INCLUSIVE grand total (sub + api), so
 * that subtraction would only re-derive an existing field and risk float drift.
 *
 * Dropped when there is no usable figure to caption: a zero/negative/non-finite
 * value, or a positive value so small `formatCurrencyWhole` emits no readable
 * quantity for it. Since ISS-4919 that floor is much lower than a cent:
 * `formatCurrencyWhole` routes the sub-cent band through `formatCostPrecise`, so
 * a real $0.004 share now captions "+$0.004 if billed to API" — a true figure —
 * and only a share below the 4dp precision floor drops out, where the formatter
 * has a bound rather than a figure (see {@link NO_FIGURE_CURRENCY_STRINGS}).
 * Exported so callers and tests assert the identical string.
 */
export function formatCostMetricDetail(
  subscriptionEstimatedCost: number | null | undefined
): string | undefined {
  if (
    subscriptionEstimatedCost == null ||
    !Number.isFinite(subscriptionEstimatedCost) ||
    subscriptionEstimatedCost <= 0
  ) {
    return undefined;
  }
  const formattedValue = formatCurrencyWhole(subscriptionEstimatedCost);
  // Drop the line when the formatter emits no usable figure: a
  // "+$0.00 if billed to API" caption states an amount while
  // showing nothing, and a sub-floor bound reads as
  // "+< $0.01 if billed to API".
  if (NO_FIGURE_CURRENCY_STRINGS.has(formattedValue)) {
    return undefined;
  }
  // FEA-4231 copy. The conditional "if" is what keeps it honest: the figure is
  // the API-equivalent (would-have-cost) of subscription-covered usage, NOT a
  // real seat fee charged to the account, and
  // `SESSIONS_COST_METRIC_CARD_INFO.how` says so in full.
  return `+${formattedValue} if billed to API`;
}

/**
 * The strings `formatCurrencyWhole` can emit that carry NO usable figure for
 * THIS caption's grammar. Used to drop the detail line rather than render a
 * no-op amount. A sub-cent-but-representable share (e.g. $0.004) is not in this
 * set since ISS-4919 and keeps its caption, because the figure is real.
 *
 * Two kinds sit here. The zero strings are the original case: an amount promised
 * with nothing behind it. The sub-floor BOUNDS are the ISS-4919 completion case
 * — `formatCurrencyWhole` no longer collapses that band to "$0.00", so the drop
 * guard can no longer key on a zero string alone, or the card would caption
 * "+< $0.01 if billed to API": grammatical nonsense ("+<") wrapped around a
 * quantity too small for a caption whose whole job is to quantify. The bound is
 * the right render for a KPI value and the wrong one for this sentence, so the
 * editorial call stays here while the strings themselves stay owned by the
 * formatter that emits them.
 */
const NO_FIGURE_CURRENCY_STRINGS = new Set([
  "$0",
  "$0.00",
  // The bounds `formatCurrencyWhole` ACTUALLY emits. These are the whole-dollar
  // tile's own bounds (`< $0.01`), not `formatCostPrecise`'s 4dp ones: after the
  // review-thread change, a whole-dollar surface states its bound at the
  // precision it renders, so keying this guard on `PRECISE_COST_BELOW_FLOOR`
  // would have matched a string this formatter can no longer produce — and let
  // "+< $0.01 if billed to API" reach the card.
  WHOLE_CURRENCY_BELOW_FLOOR,
  WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR,
]);

/**
 * Per-surface label for the Sessions summary "Cost" card (ISS-4401, the
 * alternate direction reviewer wongk proposed on FEA-4231's PR #3921). The
 * Sessions card sums `apiEstimatedCost`: the spend NOT covered by a subscription,
 * whereas the org Dashboard "Cost" KPI is the subscription-INCLUSIVE aggregate.
 * Under a single hardcoded "Cost" label the two screens showed different numbers
 * for the same word.
 *
 * The label is "cost", not "API Cost" (wongk review):
 * `apiEstimatedCost` is not strictly API-key spend — both producers fold
 * unknown/legacy-null billing sources into this bucket (desktop computes it as
 * `metered + unknown`), so "API Cost" would present unclassified usage as
 * confirmed API charges. Naming the actual bucket lets the Dashboard keep its
 * inclusive "Cost" total on screen as the honest superset without the two
 * appearing to contradict. Kept as a const beside `COST_METRIC_CARD_LABEL` so
 * every Sessions surface and its tests render the identical accessible label
 * instead of inlining the string and drifting.
 */
export const SESSIONS_COST_METRIC_CARD_LABEL = "cost";

/**
 * ISS-4773 — info copy for the Sessions "Cost" card in its HONEST mode (behind
 * `SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY`, default OFF).
 *
 * The card it replaces summed `apiEstimatedCost`, which BOTH producers define as
 * "everything not covered by a subscription" — confirmed API spend AND every
 * session whose billing mode was never determined, so the copy claimed a
 * precision the number did not have.
 *
 * The unclassified term is NOT `subscription_unknown` (stage review): that mode
 * is in `SUBSCRIPTION_MODES` (`apps/desktop/src/shared/billing-mode.ts`), so
 * `billingLedger` routes it to the SUBSCRIPTION ledger and it never entered this
 * headline at all. The bucket this flag excludes is the genuinely unclassified
 * one — `billingMode` null, the literal `"unknown"`, an unrecognized future
 * value, or a source loop with no resolvable `apiKeySource`. How large that
 * share is on any given account is therefore an open question, not a settled
 * figure, and no copy here is calibrated on a specific number.
 *
 * The rule this copy states once: the headline is money actually billed to an API
 * key; the caption is the API-EQUIVALENT value of subscription-covered usage
 * (what the flat fee delivered — never a fee charged); and usage that is neither
 * is named as such rather than quietly counted as either. Wording follows the
 * product decision recorded on ISS-4773.
 */
export const SESSIONS_COST_HONEST_METRIC_CARD_INFO = {
  what: "What the matched sessions cost that was actually billed to an API key.",
  how: "Adds up the metered cost of matched sessions billed to an API key. The line beneath estimates what your subscription-covered sessions would have cost at API rates, the value the flat fee delivered rather than a charge. Sessions whose billing couldn't be determined are counted in neither figure and are called out on that line.",
} as const;

/**
 * ISS-4773 — the Sessions Cost card's label in HONEST mode.
 *
 * NOT the bare `COST_METRIC_CARD_LABEL` ("Cost"): reclaiming that word would
 * re-open the exact collision ISS-4401 removed (stage review, twice). Three
 * different numbers would wear it on adjacent surfaces — the org Dashboard KPI
 * renders it over the subscription-INCLUSIVE aggregate (`dashboard-rows.tsx`),
 * the Sessions table's own "Cost" column prints each session's estimated cost
 * regardless of billing mode, and this tile would sum a strictly narrower basis
 * than the column directly beneath it. The narrowing has to be visible in the
 * LABEL, not only in the popover a reader has to open.
 *
 * "API-billed" rather than "Metered" because it states the thing a reader can
 * check against their own bill, and it is the same wording the honest info copy
 * and caption use, so the card says one thing in three places.
 */
export const SESSIONS_COST_HONEST_METRIC_CARD_LABEL = "API-billed Cost";

/**
 * ISS-4773 — the caption beneath the honest-mode headline.
 *
 * Carries up to two facts, in this order and joined by a middot:
 *   1. the API-equivalent value of CONFIRMED subscription-covered usage
 *      ("+$2,030 via subscription"), and
 *   2. the share whose billing could not be determined ("$16,783 billing
 *      unknown").
 *
 * Kept terse (stage review): this caption sits in a ~124px card whose rowmates
 * caption in two to four words, and the earlier 58-character version wrapped to
 * three lines and could orphan the middot at a break. The counterfactual
 * qualifier is dropped from THIS clause because the honest-mode headline label
 * already says "API-billed Cost" and its `how` copy spells the counterfactual
 * out ("would have cost at API rates, the value the flat fee delivered rather
 * than a charge"), so repeating it in four more words here would wrap the line.
 * Note the DEFAULT-mode caption DOES carry it ("+$X if billed to API"): that
 * card's label does not name the basis, so the caption has to.
 *
 * "billing unknown", NOT the bare "Unknown" the Cost FACET uses: the facet's
 * Unknown is the missing-COST population (`sessionCostIsNumeric`), which renders
 * an em-dash and contributes no dollars. This clause is the opposite — sessions
 * with a real dollar figure whose BILLING MODE was never determined. Reusing the
 * facet's word would put one label on two different populations; qualifying it
 * with "billing" also stops the phrase reading as the money being unclassified.
 *
 * Fact 2 is the whole point of the flag: excluding unclassified usage from the
 * headline stops the card overstating spend, but silently dropping it would
 * understate the population instead. Naming it keeps the card's own arithmetic
 * legible — headline + caption + unclassified is the whole matched set.
 *
 * Each clause is dropped when its value is absent, non-finite, non-positive, or
 * formats to a bare zero string (the same floor `formatCostMetricDetail` applies,
 * so a real sub-cent share still captions a true figure since ISS-4919), and the
 * whole caption is dropped when neither clause survives. Returns `undefined`
 * rather than an empty string so the MetricCard renders no detail row at all.
 */
export function formatHonestCostMetricDetail(
  subscriptionEstimatedCost: number | null | undefined,
  unknownEstimatedCost: number | null | undefined
): string | undefined {
  const clauses: string[] = [];
  const subscription = formatPositiveCurrency(subscriptionEstimatedCost);
  if (subscription !== undefined) {
    clauses.push(`+${subscription} via subscription`);
  }
  const unknown = formatPositiveCurrency(unknownEstimatedCost);
  if (unknown !== undefined) {
    clauses.push(`${unknown} billing unknown`);
  }
  return clauses.length > 0 ? clauses.join(" · ") : undefined;
}

/**
 * ISS-5401 — the caption beneath a Cost headline that dashed because not one of
 * the matched sessions carried a recorded cost.
 *
 * Says the reason, not the state: the `—` already says "unavailable", and the
 * failed-read dash on the same row says exactly that word
 * (`UNAVAILABLE_DETAIL`), so repeating it would leave a reader unable to tell a
 * broken read from an absent-cost cohort.
 *
 * "No cost recorded", NOT the Cost COLUMN's per-row "No pricing data for this
 * model" (`getCostTooltip`), even though the two conditions rhyme. That phrase
 * names a CAUSE — the pricing catalog has no rate for the model — and the
 * aggregate cannot substantiate it. Two audited cohorts reach this caption for a
 * different cause entirely, and the rows beneath them do NOT read alike: the
 * legacy-rollup cohort shows real dollars in the cell, while the
 * subscription-covered cohort shows a fabricated `$0.00` (this caption's
 * predicate is the only one of the two that declines to state a figure). The
 * full split, and why each is accepted, is the KNOWN LIMIT block on
 * {@link isCohortCostUnpriceable} — kept there, not restated here, so the two
 * cannot drift into describing different behaviour. What matters for the
 * WORDING is only that both exist: "no cost recorded" is the weaker claim the
 * tile can always stand behind — no matched session carried a cost figure — and
 * it stays true whatever the cause turns out to be, and whatever the cell beside
 * it prints. "recorded" rather than "data" (design review):
 * "data" is our word for our database and makes the tile read as a system
 * complaint; the reader thinks in money and sessions.
 *
 * Terse for the same reason the ISS-4773 caption is: this sits in a ~124px card
 * whose rowmates caption in two to four words.
 */
export const SESSIONS_COST_NO_COST_RECORDED_DETAIL = "No cost recorded";

/**
 * Format a currency figure only when it carries a real, visible amount: finite,
 * positive, and not one of the strings `formatCurrencyWhole` emits when it has no
 * figure to show. `undefined` means "there is nothing here worth stating", so
 * callers omit the clause rather than print an amount of nothing.
 *
 * Guards on {@link NO_FIGURE_CURRENCY_STRINGS}, the SAME set
 * `formatCostMetricDetail` uses, because this builds the same kind of sentence:
 * "+< $0.01 via subscription" and "< $0.01 billing unknown" are the identical
 * bound-inside-a-quantifying-clause defect, and a caption that promises an amount
 * must not then show an inequality. Keying on a zero-only set would have let both
 * through.
 */
function formatPositiveCurrency(
  value: number | null | undefined
): string | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const formatted = formatCurrencyWhole(value);
  return NO_FIGURE_CURRENCY_STRINGS.has(formatted) ? undefined : formatted;
}

/**
 * Fallback info copy for the org Dashboard's Cost KPI (wongk review on #4905).
 *
 * That surface normally feeds the card the backend's single-line `kpi.sub`, but
 * `OverviewCostKpiCard` passes `undefined` whenever the KPI or its `sub` is
 * absent, and this component's `info` DEFAULT is the Sessions copy. Sessions
 * itself always passes `info` explicitly (from `resolveCostCardPresentation`),
 * so in production that default was reachable only from the Dashboard — the one
 * surface it does not describe. Before this constant existed the Dashboard's
 * empty-`sub` state therefore rendered a tooltip about "filtered sessions" and a
 * caption beneath the number that this surface never draws.
 *
 * The basis is genuinely different, not just the wording: the Dashboard KPI is
 * the subscription-INCLUSIVE aggregate (the same distinction
 * {@link SESSIONS_COST_METRIC_CARD_LABEL} exists to keep visible), and it renders
 * no detail line, so this copy names the inclusive basis and promises no caption.
 *
 * Single-line `what` with no `how`, matching the four rowmates that render
 * `{ what: kpi.sub }` — the Dashboard row deliberately shares one voice and one
 * tooltip height.
 *
 * Kept beside the Sessions copy rather than in the insights slice so the three
 * per-surface strings sit in one file and can be diffed against each other,
 * matching {@link COST_METRIC_CARD_LABEL}, the Dashboard's fallback LABEL, which
 * already lives here for the same reason.
 */
export const DASHBOARD_COST_METRIC_CARD_INFO = {
  what: "Estimated agent cost in the selected range, including subscription-covered usage.",
} as const;
