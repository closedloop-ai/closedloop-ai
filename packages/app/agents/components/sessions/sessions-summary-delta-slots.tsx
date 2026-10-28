"use client";

/**
 * How a Sessions summary card's DELTA SLOT gets filled — the one place that
 * decides whether a card shows a movement chip, the "No prior period"
 * placeholder, or nothing at all.
 *
 * Extracted from `sessions-summary-cards.tsx` (FEA-4202) when the delivery cards
 * became a third consumer alongside the always-available cards and the Cost
 * tile. Three call sites resolving the same slot inside one 1,100-line component
 * is how the "when may we grade a movement" rule drifts per card; here it reads
 * as one statement, and the component file stops growing (AGENTS.md file-size
 * discipline).
 */

// Cross-slice import (agents → insights), the same one `session-summary-deltas`
// makes and for the same reason: `NO_COMPARISON_CHIP_LABEL` is the canonical
// word for this state, and the delivery card in this very strip already renders
// it from this module — so the label is borrowed rather than re-typed, and the
// module is already in the surface's graph.
import { NO_COMPARISON_CHIP_LABEL } from "@repo/app/insights/components/kpi-delta-placeholder";
import type {
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { ReactNode } from "react";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import { CostCardPresentationMode } from "./cost-card-presentation";

/**
 * ISS-7422: the accessible name for the pending delta slot.
 *
 * Names the STATE ("still being read"), never an outcome — the whole defect
 * being repaired is a slot that announced an outcome it did not have. Exported
 * so a test asserts the shipped string rather than a copy of it.
 */
export const SUMMARY_COMPARISON_PENDING_LABEL = "Comparison loading";

/**
 * ISS-5315: the spreadable delta slot, as a union that keeps `delta` and
 * `deltaPolarity` inseparable — the same discrimination `MetricCard`'s own props
 * enforce, so a card can never be handed a movement without the polarity that
 * grades it. An "all optional" object would satisfy neither branch of that
 * union and would not compile at the call site, which is the point.
 *
 * ISS-5842 (follow-up): `deltaTreatment` sits on BOTH arms, unconditionally
 * required. `MetricCard` defaults an absent `deltaTreatment` to
 * {@link MetricDeltaTreatment.Legacy}, so a card wired through this bag without
 * one does not fail — it silently renders the pre-ISS-5842 chip while its
 * siblings render the unified pill, which is exactly how the Sessions and Total
 * Tokens cards ended up on a different delta family from the Cost and delivery
 * cards in the same row.
 *
 * ## What the type actually guarantees, and what it does not
 *
 * Stated precisely, because an earlier draft of this comment claimed the
 * omission was "unrepresentable" and that is NOT what the types buy (review on
 * #4907). What is guaranteed: the bag cannot be CONSTRUCTED without a treatment
 * — `deltaSlotProps` takes it as a required parameter, so a new call site does
 * not compile until it resolves one.
 *
 * What is NOT guaranteed: that the treatment survives the trip to `MetricCard`.
 * A JSX spread is not excess-property checked, so a WRAPPER card that
 * destructures explicit props — rather than spreading the bag straight through —
 * drops any key it did not declare, silently and without a type error.
 * `CostMetricCard` was exactly that wrapper: it took the strip's bag, declared no
 * `deltaTreatment`, and dropped it on the floor, rendering correctly only because
 * it resolved the same flag internally. That specific hole is now closed (it
 * declares and prefers the prop), but the SHAPE of the hole is not closable in
 * the type system: nothing stops the next wrapper from repeating it.
 *
 * ## What closes it instead
 *
 * A behavioural guard, in `__tests__/sessions-summary-cards-delta-treatment.test.tsx`:
 * that suite renders the whole strip under `UnifiedPill` and asserts the
 * unified-ONLY classes on every chip-bearing card, plus a `toHaveLength` on the
 * named card list. A new wrapper that swallows the treatment fails the per-card
 * assertion; a new card that renders a chip at all fails the count until it is
 * added to the list and therefore covered. Keep that test in step with this
 * module — it, not the signature, is what makes the guarantee stick end to end.
 */
export type SessionsDeltaSlotProps =
  | {
      delta: number;
      deltaPolarity: MetricPolarity;
      deltaLabel: string;
      deltaTreatment: MetricDeltaTreatment;
    }
  | {
      delta?: undefined;
      deltaPolarity?: undefined;
      deltaLabel?: undefined;
      deltaTreatment: MetricDeltaTreatment;
    };

/**
 * Every card key this module can fill a slot for. Spelled out rather than
 * widened to `keyof SessionSummaryDeltas`, which would also admit the object's
 * non-entry fields — `label` and (FEA-4202) `deliveryCompared`.
 */
export type SessionsDeltaKey =
  // ISS-4748: the subscription-inclusive total, and since ISS-10636 the only
  // basis the Cost card headlines. Kept in step with `SessionSummaryDeltas` — a
  // key here that the deltas object cannot carry would resolve to no chip at
  // all. ISS-8791 removed `meteredCost` from this union with the honest
  // presentation that was its only producer, and ISS-10734 removed `apiCost`
  // once no mode resolved to it; the WIRE members they mirrored
  // (`AgentSessionComparisonMetric.MeteredCost` / `.ApiCost`) are deliberately
  // still emitted, as version-skew surface.
  "totalCost" | "prsShipped" | "sessions" | "tokens";

/**
 * ISS-5315: one card's delta props, or the movement-free slot when that card has
 * no comparable movement — at which point `MetricCard` fills the same slot with
 * `deltaPlaceholder`. Spreading a prepared object keeps the `delta`/
 * `deltaPolarity` pair together.
 *
 * The `deltas.label` guard is load-bearing beyond captioning: a null label IS
 * the "All time" range (`sessionPriorWindowLabel`), which has no prior period at
 * all, so it must yield no chip on any card regardless of what entries the
 * object happens to carry.
 *
 * ## ISS-5842 (follow-up): `treatment` is a REQUIRED parameter, not a prop
 *
 * The surface's delta treatment is a property of the SURFACE, not of one card's
 * movement, so it is resolved once by the caller — `useMetricDeltaTreatment()`
 * — and threaded in. This is a plain function rather than a hook precisely so it
 * stays callable from a `.stories.tsx` render helper and from a loop over card
 * keys; taking the treatment as an argument keeps it that way.
 *
 * Making it required is the whole point of the change: every card in the
 * Sessions strip now inherits the treatment from the same bag that carries its
 * movement, so a card added tomorrow cannot land on the `Legacy` default merely
 * by forgetting a prop, and a call site cannot be added without stating one.
 *
 * ### Why the movement-free arm carries it too
 *
 * The early return is NOT `{}` any more. Today `metric-card.tsx` reads
 * `deltaTreatment` only inside its `showDelta` branch — `deltaPlaceholder` is a
 * caller-supplied node rendered verbatim — so on this arm the value is inert and
 * the flag-off/flag-on renders are identical. It is emitted anyway because the
 * alternative is a bag whose shape changes with the DATA: a card would carry the
 * treatment when it has a movement and drop it when it does not, which is a
 * render-state-dependent presentation family — the same class of defect as the
 * delivery card that passed `deltaTreatment` on one of its four branches. One
 * arm of a union that omits the prop is also one arm a future consumer can read
 * as "no treatment declared here", so the treatment stays unconditional and the
 * "is there a movement" question stays the only thing the union discriminates.
 */
export function deltaSlotProps(
  deltas: SessionSummaryDeltas | undefined,
  key: SessionsDeltaKey,
  treatment: MetricDeltaTreatment
): SessionsDeltaSlotProps {
  const entry = deltas?.[key];
  if (!(deltas?.label && entry)) {
    return { deltaTreatment: treatment };
  }
  return {
    delta: entry.delta,
    deltaLabel: deltas.label,
    deltaPolarity: entry.deltaPolarity,
    deltaTreatment: treatment,
  };
}

/**
 * ISS-5315: keep a delta only while the value beside it is the settled cloud
 * figure the prior-period read was computed against.
 *
 * Scoped to the ALWAYS-AVAILABLE cards: these three states are the local-fallback
 * source machine those cards run (`AlwaysAvailableCards`). The cloud-only
 * delivery cards do not share it — they have their own honesty gates (signed
 * out, failed read, absent value), applied where those states are decided.
 */
export function resolveComparableDeltas(
  deltas: SessionSummaryDeltas | undefined,
  state: {
    cardsLoading: boolean;
    errored: boolean;
    showingLocalFallback: boolean;
  }
): SessionSummaryDeltas | undefined {
  if (state.cardsLoading || state.errored || state.showingLocalFallback) {
    return undefined;
  }
  return deltas;
}

/**
 * ISS-5315: what fills a card's delta slot when there is no honest comparison to
 * make — an "All time" range (no window before "everything"), a prior read that
 * has not landed, or a value that is loading, errored, or from the local
 * fallback. It occupies the SAME slot as the chip so the row's height does not
 * move between the two states, and it says which of the two the reader is
 * looking at rather than silently leaving a gap.
 */
export const SUMMARY_NO_PRIOR_PERIOD = (
  <span className="text-muted-foreground text-xs">No prior period</span>
);

/**
 * ISS-7525: the same slot when a prior period WAS measured and the producer
 * declined to state a ratio for this card.
 *
 * This is a claim about the COMPARISON — there was a window before this one, we
 * read it, and no honest percent came out (a base too near zero to divide by, a
 * magnitude past the display ceiling, a figure missing on one side). Printing
 * the sibling's "there was nothing before it" over that is the defect this
 * constant exists to end.
 *
 * Scoped honestly: this repairs the DECLINED cause only. One more cause still
 * lands on the sibling sentence and should not — a prior-window read that
 * THREW. `readOptionalPriorFigures` (`apps/api/.../usage-summary.ts`) catches,
 * logs, and returns undefined, so the response omits `comparison` wholesale
 * even though a real prior window resolved; the client cannot tell that from a
 * range that never had one. Unchanged by this ticket and not silently folded
 * in: telling it apart needs a third sentence, which is copy, which is the
 * operator's call. Reported, not invented.
 *
 * Distinguished in WORDS, in the same muted caption token and the same slot
 * geometry as its sibling, so nothing about the difference is carried by colour
 * (WCAG 1.4.1) and nothing about it is invisible to assistive tech: the text IS
 * the statement, and it is the same text either way.
 *
 * Deliberately a bare span with no tooltip, matching
 * {@link SUMMARY_NO_PRIOR_PERIOD} beside it rather than the `KpiDeltaPlaceholder`
 * this word is borrowed from — that component wraps the same label in a
 * focusable button with a reason tooltip, so within one row the delivery cards
 * explain themselves and these three do not. That asymmetry predates this
 * change and is a real gap; it is named here so the next reader closes it
 * deliberately for the whole slot rather than bolting a tooltip onto one arm.
 *
 * ## The words are borrowed, not minted
 *
 * `NO_COMPARISON_CHIP_LABEL` — the label the delivery pair's
 * `KpiDeltaPlaceholder` already carries two cards to the right in this very
 * row. ISS-4995 settled that "comparison" is the ONE noun this concept gets,
 * in the chip and in every reason sentence behind it, and a third vocabulary
 * for a state the row already names would make a reader work out whether they
 * were being told two different things. They are not.
 *
 * A drafted "Not comparable" was the visual-QA finding that sent this here: it
 * is adjectival, so it reads as a property of the reader's data rather than of
 * our arithmetic — the blame ISS-5003 deliberately reworded the sibling KPI
 * sentence away from — and it reads oddly for the case where the prior window
 * existed and was simply empty, which this flag also covers. The house label is
 * outcome-shaped and reason-agnostic, which is why it survives every cause.
 *
 * The wording itself remains the operator's call, and there IS a competing
 * precedent worth stating rather than burying: the Agents summary strip's
 * `INVOCATIONS_DELTA_NOT_COMPARABLE` ("Not comparable", ISS-6205) fills the
 * analogous slot for a previous window that exists and was withheld. It is the
 * closer match on cause — it is about two windows counted differently — and the
 * further one on placement, because nothing beside it in that row says
 * "comparison". This slot's rowmates do, twice, so row-local consistency won.
 * Flipping the decision is this one line.
 */
export const SUMMARY_COMPARISON_DECLINED = (
  <span className="text-muted-foreground text-xs">
    {NO_COMPARISON_CHIP_LABEL}
  </span>
);

/**
 * ISS-7422: the delta slot's pending shimmer geometry.
 *
 * One constant so the loading SHELL and the settled strip cannot drift into two
 * differently-sized shimmers for one state — the shell's slot reserves exactly
 * the height the settled slot fills, which is the whole reason it reserves.
 */
const COMPARISON_SHIMMER_CLASS = "h-4 w-24 rounded";

/**
 * ISS-7422: the pending slot as the LOADING SHELL renders it — a bare shimmer,
 * byte-identical to what that component rendered before this ticket.
 *
 * No announced name here, deliberately. The shell's whole row carries
 * `aria-busy` (`SummaryCardRow busy`), which already tells assistive tech the
 * region is updating and suppresses live-region chatter underneath it; a
 * per-card announcement would be five voices for one fact. The settled strip has
 * no such row-level signal, which is why {@link SUMMARY_COMPARISON_PENDING}
 * carries its own name and this does not.
 */
export const SUMMARY_COMPARISON_SHELL_SHIMMER = (
  <Skeleton className={COMPARISON_SHIMMER_CLASS} />
);

/**
 * ISS-7422: the same slot on a SETTLED card whose comparison is still being read.
 *
 * A shimmer rather than a sentence, because every sentence available here is a
 * verdict the read has not returned — the loading shell's own comment spells out
 * why ("printing that line here would be a claim the read has not returned").
 *
 * The shimmer is decorative, so the state is carried in TEXT for assistive tech
 * rather than in the visual alone: a live region announces it, which also keeps
 * pending distinguishable from "No prior period" without relying on colour
 * (WCAG 1.4.1). This is the arm the honest-loading gate controls; the shell's
 * arm above ships ungated because it is unchanged.
 */
export const SUMMARY_COMPARISON_PENDING = (
  <span className="flex min-w-0 items-center" role="status">
    <span className="sr-only">{SUMMARY_COMPARISON_PENDING_LABEL}</span>
    <Skeleton aria-hidden className={COMPARISON_SHIMMER_CLASS} />
  </span>
);

/**
 * ISS-7422 / ISS-7525: which affordance fills an always-available card's empty
 * delta slot with the `sessions-summary-honest-loading` gate ON.
 *
 * The states this resolves between are the whole point, and they are FOUR, not
 * two: a host that does not compare gets nothing, a pending read gets the
 * shimmer, a settled read whose prior window was measured and declined gets
 * {@link SUMMARY_COMPARISON_DECLINED}, and only a settled absence of a prior
 * period at all earns the "No prior period" sentence.
 *
 * ## Why one gate covers both honesty repairs
 *
 * The gate is the shared `sessions-summary-honest-loading` key (PostHog on web,
 * the Labs toggle desktop already registers), reused rather than joined by a
 * second one. It is the gate that owns THIS SLOT telling the truth about its own
 * state, and both repairs are the same defect in it — a sentence asserting a
 * verdict the read did not return. Minting a second key would put one slot under
 * two independent gates and make three of the four reachable combinations
 * partial-honesty states nobody designed: a build where pending is honest and
 * declined still lies, or the reverse.
 *
 * The gate itself is READ by the component that swaps on it, which picks this
 * shape or {@link shippedSummaryDeltaPlaceholder} whole; the boolean never
 * crosses into this module (`no-threaded-feature-flag`).
 */
export function honestSummaryDeltaPlaceholder(
  deltas: SessionSummaryDeltas | undefined
): ReactNode {
  if (!deltas) {
    return undefined;
  }
  if (deltas.pending) {
    return SUMMARY_COMPARISON_PENDING;
  }
  // Ordered under `pending` deliberately. `buildSessionSummaryDeltas` cannot
  // emit both flags today — `pending` rides its suppressed early return and
  // `priorPeriodMeasured` is only set past it — but the TYPE permits both, and
  // this function is exported, so the precedence is part of its contract rather
  // than an accident of one producer. A read still in flight has not declined
  // anything, so announcing a decline there would be ISS-7422's defect wearing
  // this ticket's clothes. Pinned by the precedence case in
  // `__tests__/sessions-summary-comparison-declined.test.tsx`, because an
  // unenforced ordering comment is one a refactor silently inverts.
  if (deltas.priorPeriodMeasured) {
    return SUMMARY_COMPARISON_DECLINED;
  }
  return SUMMARY_NO_PRIOR_PERIOD;
}

/**
 * The same slot with the gate OFF — the shipped, closed-default shape. A host
 * that does not compare still gets nothing; every other state takes the "No
 * prior period" sentence, so this arm renders byte-for-byte what ships today.
 */
export function shippedSummaryDeltaPlaceholder(
  deltas: SessionSummaryDeltas | undefined
): ReactNode {
  return deltas ? SUMMARY_NO_PRIOR_PERIOD : undefined;
}

/**
 * FEA-4202: the delta contract as the two DELIVERY cards may read it — the same
 * object, or `undefined` when this surface does not compare that pair.
 *
 * `resolveComparableDeltas` above is the analogous gate for the always-available
 * cards; this is the delivery pair's, and it is a ROLLOUT question rather than a
 * data-state one. It exists because the delivery cards' participation is not
 * implied by the object existing: ISS-5315 already hands one to every caller for
 * the always-available cards, so reading presence as consent published the new
 * "No comparison" pill to hosts that never opted in (review threads on #4681).
 *
 * Collapsing to `undefined` deliberately reuses the host-does-not-compare path
 * the desktop Sessions view already takes, so a non-participating delivery card
 * has ONE absent-state shape — no chip and no placeholder — rather than a second
 * one that has to be kept in step with it.
 */
export function deliveryComparableDeltas(
  deltas: SessionSummaryDeltas | undefined
): SessionSummaryDeltas | undefined {
  return deltas?.deliveryCompared ? deltas : undefined;
}

/**
 * #4480 / ISS-4748: which delta entry describes the Cost card's HEADLINE.
 *
 * Every mode headlines `totalEstimatedCost` since ISS-10636, so both modes
 * resolve to the same entry and ISS-10734 retired the `apiCost` one no mode
 * named. The map survives because the mode set is what a new basis would have to
 * extend, and an unmapped member must fail `tsc` rather than silently pair a
 * chip with a figure the card did not print (#4480).
 *
 * Extracted here (PR #4814 review) so the mapping has ONE definition. It was
 * inline at its single call site in `sessions-summary-cards.tsx`, which meant a
 * story could only mirror it by re-typing the two key literals — and a mirrored
 * literal does not move when the thing it mirrors does, so the story would stay
 * green through exactly the mis-pairing it was written to catch.
 */
const COST_DELTA_KEY_BY_MODE: Record<
  CostCardPresentationMode,
  SessionsDeltaKey
> = {
  [CostCardPresentationMode.Breakdown]: "totalCost",
  // ISS-9969: the same headline as breakdown, minus the lanes.
  [CostCardPresentationMode.Total]: "totalCost",
};

export function costDeltaKey(
  presentation: Readonly<{ mode: CostCardPresentationMode }>
): SessionsDeltaKey {
  // An exhaustive Record, not a conditional: a fourth mode fails `tsc` here
  // instead of silently falling through to whichever basis the `else` names.
  return COST_DELTA_KEY_BY_MODE[presentation.mode];
}
