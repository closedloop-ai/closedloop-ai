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

import type {
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";

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
  | "apiCost"
  | "meteredCost"
  | "prsShipped"
  | "sessions"
  | "tokens";

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
 * #4480: which delta entry describes the Cost card's HEADLINE.
 *
 * The Cost card can print either basis — `resolveCostCardPresentation` returns
 * the metered figure when the honesty flag is on and the producer sent a usable
 * split, and the API figure otherwise — and the chip has to grade the one the
 * card actually rendered. Pairing the wrong entry with the headline puts two
 * different figures under one chip, which is the regression #4480 closed.
 *
 * Extracted here (PR #4814 review) so the mapping has ONE definition. It was
 * inline at its single call site in `sessions-summary-cards.tsx`, which meant a
 * story could only mirror it by re-typing the two key literals — and a mirrored
 * literal does not move when the thing it mirrors does, so the story would stay
 * green through exactly the mis-pairing it was written to catch.
 */
export function costDeltaKey(
  presentation: Readonly<{ honest: boolean }>
): SessionsDeltaKey {
  return presentation.honest ? "meteredCost" : "apiCost";
}
