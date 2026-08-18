/**
 * ISS-5315 / ISS-5809 — the Sessions summary cards' "vs. prior" comparison.
 *
 * The cards summarize the sessions inside the active time window and chip the
 * movement against the same-length window immediately before it. ISS-5809 moved
 * the ARITHMETIC to the producer: the usage read returns a signed percent per
 * comparable card (`AgentSessionUsageSummary.comparison`), and this module maps
 * those percentages onto the cards' delta slots with the polarity that grades
 * each one. Before that, the page fetched the entire usage summary a second time
 * for the prior window and subtracted here.
 *
 * The honesty rules did not move, they were RE-SITED. The producer now owns them
 * (see `agent-session-usage-comparison.ts`), and they surface here as one rule:
 *
 *  1. **An absent entry is not a zero.** A card gets a chip only when the producer
 *     emitted a percent for it. No prior window ("All time"), a prior base too
 *     near zero to divide by, a magnitude past the display ceiling, or a figure
 *     missing on either side all arrive here identically — as an absent key — and
 *     all render the "No prior period" placeholder rather than a fabricated 0%.
 *  2. **A loading, errored, or fallback-sourced read yields no deltas.** The
 *     `suppressed` flag still lives with the caller, because only the caller knows
 *     whether the figures on screen and the comparison beside them came from the
 *     same generation of the same read.
 *  3. **A metric whose two sides are not both windowed gets no entry at all.**
 *     `LOC / $ (Merged)` is deliberately absent from the contract — see
 *     {@link SessionSummaryDeltas.prsShipped} and the note below it.
 *
 * Like-for-like is now structural rather than conventional: the comparison rides
 * the SAME response as the figures it grades, so the two cannot describe
 * different filter scopes or different generations of the same scope.
 */
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { AgentSessionComparisonMetric } from "@repo/api/src/types/agent-session-usage-comparison";
// Cross-slice import (agents → insights), intentional per packages/app/AGENTS.md:
// the cadence captions this module emits ("WoW"/"MoM"/"QoQ") must be the SAME
// strings the Insights overview captions its KPI deltas with, or the two surfaces
// end up disagreeing about what "MoM" names for one identical range. Copying the
// map here is what would create that drift, so the Insights slice stays the one
// owner and this reads from it. `dashboard-range` is the narrowest stable surface
// carrying it — a pure, dependency-free constants module, not a component or hook.
import { GROWTH_LABEL } from "@repo/app/insights/lib/dashboard-range";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";

/** Days covered by each bounded Sessions time window. */
const SESSION_RANGE_DAYS: Record<Exclude<DateRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** One card's delta, paired with the polarity that grades its direction. */
export type SessionSummaryDelta = {
  delta: number;
  deltaPolarity: MetricPolarity;
};

/**
 * The delta slot inputs for the always-available summary cards.
 *
 * Its PRESENCE is the host declaring "this surface compares periods" — that is
 * what earns the "No prior period" placeholder in the delta slot. A host that
 * does not compute a comparison at all passes nothing, and its cards render
 * neither a chip nor a placeholder — rather than a permanent "No prior period"
 * that implies a comparison it is never going to make.
 *
 * ISS-6041 narrowed which hosts those are. The desktop Sessions view used to be
 * named here wholesale, on the reasoning that its local producer has no
 * prior-window read — true of Local mode, and only Local mode. In Cloud mode that
 * view reads the SAME `createHttpAgentSessionsDataSource` the web page does, so
 * the producer that serves web's comparison was already serving desktop's
 * figures; the gap was that the combined `pageData` port had no field to carry
 * the ISS-5809 opt-in. It does now, so desktop compares in Cloud mode (behind the
 * shared Grid Parity gate, like web's cadence captions) and still passes nothing
 * in Local mode, where the deferral is a producer limit rather than a wiring one.
 */
export type SessionSummaryDeltas = {
  /**
   * Caption beside each chip, e.g. "vs. prior 30 days". Null when the active
   * range has no prior period at all ("All time"), in which case no card carries
   * a chip and every one of them shows the placeholder.
   */
  label: string | null;
  /**
   * FEA-4202: whether the DELIVERY pair (`PRs Shipped`, `LOC / $`) takes part in
   * this surface's comparison at all.
   *
   * Distinct from the object's mere PRESENCE, which declares only that the
   * ALWAYS-AVAILABLE cards compare — ISS-5315 shipped those, and every existing
   * caller therefore hands the component a delta object on every bounded range.
   * The delivery pair fills its slot with a VISIBLE "No comparison" affordance
   * whenever it participates, so "an object exists" cannot also mean "render the
   * new delivery footer": that reading put the pill on both delivery cards for
   * every caller, including the ones with the rollout flag off (review threads
   * on #4681).
   *
   * Absent/false means "not these two", so participation is opt-in and a delta
   * object built by a host that has not adopted the rollout keeps the ISS-5315
   * delivery footer byte-for-byte.
   */
  deliveryCompared?: boolean;
  sessions?: SessionSummaryDelta;
  tokens?: SessionSummaryDelta;
  /**
   * #4480: the Cost card's movement, emitted on BOTH bases the card can put in
   * its headline — `resolveCostCardPresentation` picks `meteredEstimatedCost`
   * when the honesty flag is on and the producer sent a usable split, and
   * `apiEstimatedCost` otherwise. A single "cost" delta would have graded
   * whichever basis this module happened to choose against whatever the card
   * actually rendered, which is a comparison between two different figures. The
   * card reads the entry matching the basis it resolved.
   */
  meteredCost?: SessionSummaryDelta;
  apiCost?: SessionSummaryDelta;
  /**
   * FEA-4202: the `PRs Shipped` card's movement — the one delivery metric whose
   * two sides are the same shape of figure.
   *
   * `mergedPrCount` is bounded at the PR's own `mergedAt` inside the requested
   * window, over a session scope that carries every facet filter and strips only
   * the session-activity dates. ISS-5809 evaluates that one collected merged-PR
   * set against both windows, so the two counts are the same population measured
   * over two adjacent equal-length windows — like-for-like by construction.
   *
   * ## Why there is no `locPerDollar` sibling here
   *
   * `LOC / $ (Merged)` is the other delivery card and it is still deliberately
   * NOT compared, though for a different reason since ISS-6398.
   *
   * It used to be the ATTRIBUTION problem: the denominator was an all-time API
   * spend on both sides, so the ratio reduced exactly to the merged-gross-lines
   * ratio and a "▲ n% WoW" under a label reading "LOC / $" credited spend
   * efficiency for a movement cost contributed nothing to. ISS-6398 windowed the
   * divisor, so that objection is gone.
   *
   * What remains is an ORDERING problem, not a missing figure. The prior window's
   * API-billed spend IS computed server-side (the comparison read runs the shared
   * cost classifier over the prior `where`), but it runs AFTER the delivery pass
   * that would need it — so the delivery producer evaluates the prior window for
   * `mergedPrCount` only, and a prior LOC/$ built there would divide prior lines by
   * CURRENT dollars: arithmetically wrong, not merely mislabelled. No entry is
   * emitted until those two reads are reordered (rule 3).
   */
  prsShipped?: SessionSummaryDelta;
};

/**
 * Caption for the delta chips of a bounded range; null for "all time" (which has
 * no prior period, so no card carries a chip).
 *
 * `comparisonV2Enabled` is the FEA-4202 rollout gate — see
 * {@link buildSessionSummaryDeltas}. ON, the caption is the period-over-period
 * cadence, read from the SAME `GROWTH_LABEL` map the Insights overview
 * dashboard captions its KPI deltas with, so the two surfaces cannot end up
 * disagreeing about what "MoM" names. OFF it stays the ISS-5315 wording,
 * byte-for-byte, so a flag-off build is unchanged.
 *
 * `GROWTH_LABEL` also carries an `all` entry ("all time"); this function returns
 * null before reaching it, because "All time" earns no chip at all here rather
 * than a chip captioned with a period that does not exist.
 */
export function sessionPriorWindowLabel(
  dateRange: DateRange,
  comparisonV2Enabled = false
): string | null {
  if (dateRange === "all") {
    return null;
  }
  if (comparisonV2Enabled) {
    return GROWTH_LABEL[dateRange];
  }
  return `vs. prior ${SESSION_RANGE_DAYS[dateRange]} days`;
}

/**
 * The read states in which a landed comparison must NOT be rendered.
 *
 * ISS-5809 collapsed the Sessions page to a single usage read, which removes the
 * #4480 hazard this gate originally existed for (grading a landed prior response
 * against the OTHER query's still-cached generation). What remains is simpler and
 * still real: while the read is loading, errored, showing placeholder data, or
 * refetching, the FIGURES on screen are not necessarily the ones the comparison
 * beside them describes — so no chip is honest.
 *
 * Named and exported rather than inlined at the call site because it is the one
 * rule the host owns, and inline boolean chains are where a condition silently
 * goes missing.
 */
export function shouldSuppressSessionComparison(read: {
  isLoading: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  isFetching: boolean;
}): boolean {
  return (
    read.isLoading || read.isError || read.isPlaceholderData || read.isFetching
  );
}

/**
 * Map the producer's period-over-period percentages onto the summary cards' delta
 * slots.
 *
 * Always returns an object, because a caller that calls this IS a surface that
 * compares periods — see {@link SessionSummaryDeltas}. Individual cards get no
 * entry whenever the producer emitted no honest comparison for them, and the card
 * then shows the "No prior period" placeholder rather than grading a number it
 * does not have.
 */
export function buildSessionSummaryDeltas({
  dateRange,
  current,
  suppressed = false,
  comparisonV2Enabled = false,
}: {
  dateRange: DateRange;
  current: AgentSessionUsageSummary | undefined;
  /**
   * Set while the current figures are loading, errored, or sourced from the
   * local fallback — any state where the rendered figures and the comparison
   * beside them may not describe the same read.
   */
  suppressed?: boolean;
  /**
   * FEA-4202's rollout gate, resolved by the HOST from the shared `Grid Parity`
   * flag (`grid-table-v2` — PostHog on web, the Labs toggle on desktop) and
   * passed in rather than read here, because this module is also imported by
   * mount sites with no flag provider. Default OFF, so every existing caller
   * keeps the ISS-5315 behavior exactly.
   *
   * ON it turns on the two perceivable additions together — they are one
   * change: the cadence captions (`WoW`/`MoM`/`QoQ`) and the `PRs Shipped`
   * chip. It never relaxes an honesty rule; a gate that could manufacture a
   * delta would defeat the point of the module.
   */
  comparisonV2Enabled?: boolean;
}): SessionSummaryDeltas {
  const label = sessionPriorWindowLabel(dateRange, comparisonV2Enabled);
  // The gate rides the RETURNED object, not just the entries it emits, because
  // the delivery pair's perceivable addition is its placeholder as much as its
  // chip — and the placeholder is exactly what the "no honest comparison" paths
  // below return. Carrying it on both return paths keeps a flag-off build's
  // delivery footer unchanged in every one of those states, not only the ones
  // that reach an entry (review threads on #4681).
  const deliveryCompared = comparisonV2Enabled;
  const deltas = current?.comparison?.deltas;
  if (label === null || suppressed || !deltas) {
    return { deliveryCompared, label };
  }
  const result: SessionSummaryDeltas = { deliveryCompared, label };
  // More sessions is more work getting done, so a rise reads as an improvement.
  assignDelta(
    result,
    "sessions",
    deltas.sessions,
    MetricPolarity.HigherIsBetter
  );
  // Token VOLUME is deliberately neutral — it is the substance of spend, so
  // calling its rise "better" would contradict the Cost card beside it (the
  // reasoning `MetricPolarity.Neutral` was introduced for).
  assignDelta(result, "tokens", deltas.tokens, MetricPolarity.Neutral);
  // #4480: spend rising is not an improvement on its own — it is the same
  // substance as token volume — so Cost is graded `LowerIsBetter`, the polarity
  // a spend figure carries everywhere else in the product. Both bases are mapped
  // because the card reads whichever one its headline resolved to.
  assignDelta(
    result,
    "meteredCost",
    deltas.meteredCost,
    MetricPolarity.LowerIsBetter
  );
  assignDelta(result, "apiCost", deltas.apiCost, MetricPolarity.LowerIsBetter);
  // FEA-4202: shipping more merged PRs is more delivery, so a rise reads as an
  // improvement — the same grading the Sessions count carries. Gated because the
  // chip itself is the perceivable addition; the producer's honesty rules are not
  // gated and still decide whether a percent exists at all.
  if (comparisonV2Enabled) {
    assignDelta(
      result,
      "prsShipped",
      deltas.prsShipped,
      MetricPolarity.HigherIsBetter
    );
  }
  return result;
}

/**
 * Write one card's slot, or leave it empty.
 *
 * An absent percent is the producer declining to compare that card — no prior
 * window, no baseline to divide by, a magnitude past the ceiling, or a figure
 * missing on one side. All of them mean "no chip", so they share one guard rather
 * than one per card, which is what stops a metric added later from arriving with a
 * subtly different idea of what counts as a usable comparison.
 */
function assignDelta(
  target: SessionSummaryDeltas,
  key: AgentSessionComparisonMetric,
  delta: number | undefined,
  deltaPolarity: MetricPolarity
): void {
  if (typeof delta !== "number") {
    return;
  }
  target[key] = { delta, deltaPolarity };
}
