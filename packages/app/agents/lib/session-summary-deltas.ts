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
 *     missing on either side all arrive here identically — as an absent key —
 *     and none of them fabricates a 0%. ISS-7525: they do NOT all render the
 *     same sentence, though. The first is a fact about the range; the rest are
 *     the producer weighing a prior window it really measured and declining to
 *     state a ratio, which {@link SessionSummaryDeltas.priorPeriodMeasured}
 *     separates so the slot stops claiming there was nothing to compare.
 *  2. **A loading, errored, or fallback-sourced read yields no deltas.** The
 *     `suppressed` flag still lives with the caller, because only the caller knows
 *     whether the figures on screen and the comparison beside them came from the
 *     same generation of the same read.
 *  3. **A metric whose two sides are not both windowed gets no entry at all.**
 *     `LOC / $` is deliberately absent from the contract — see
 *     {@link SessionSummaryDeltas.prsShipped} and the note below it.
 *
 * Like-for-like is now structural rather than conventional: the comparison rides
 * the SAME response as the figures it grades, so the two cannot describe
 * different filter scopes or different generations of the same scope.
 */
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
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
  "60d": 60,
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
   * ISS-7422: the comparison for the scope on screen has not settled yet, so an
   * absent entry below means "not known", NOT "the producer declined to compare".
   *
   * This is the third state the contract was missing. Before it, a slot had only
   * two shapes — an entry, or no entry — and the renderer read every empty slot
   * as the settled "No prior period". A read in flight therefore published a
   * verdict it had not received, which is precisely the claim the surrounding
   * honesty rules exist to prevent.
   *
   * Never set on an "All time" range: a null {@link label} is a settled fact
   * about the range itself, and no response is going to change it.
   */
  pending?: boolean;
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
  /**
   * ISS-7525: the producer MEASURED a prior period for this scope — the
   * comparison rode the same response as the figures, carrying the window it
   * was measured over — whether or not it emitted a percent for any given card.
   *
   * The fourth state the contract was missing, and the mirror of `pending`
   * above. `pending` separates "not known yet" from "settled"; this separates
   * the two SETTLED absences that were rendering as one sentence:
   *
   *  - the producer weighed a real prior window and DECLINED to state a ratio
   *    for this card (a base too near zero to divide by, a magnitude past the
   *    display ceiling, a figure missing on one side) — set;
   *  - the response carried no comparison at all — unset. Two causes land
   *    here and only the first is honestly described by the sentence it
   *    renders: an "All time" range that genuinely has no window before it,
   *    and (ISS-7525, NOT repaired here) a prior-window read that THREW, which
   *    `readOptionalPriorFigures` degrades to the same absence. Telling those
   *    apart needs a third sentence — copy, and so the operator's call — so it
   *    is reported rather than invented.
   *
   * "We did not compute this" and "there is nothing to compute" are different
   * claims, and the slot printed the second over the first (pre-existing since
   * ISS-5809). Set only on a SETTLED, unsuppressed read of a bounded range: a
   * suppressed read is not evidence about the prior period, and a null
   * {@link label} is a fact about the range that outranks anything the producer
   * sent.
   *
   * Omitted rather than set false when there was no measured prior period, the
   * same way every other optional field on this object is.
   */
  priorPeriodMeasured?: boolean;
  sessions?: SessionSummaryDelta;
  tokens?: SessionSummaryDelta;
  /**
   * ISS-4748 — the subscription-inclusive grand total, and since ISS-10636 the
   * ONLY basis the Cost card headlines. The card still reads the entry matching
   * the basis it resolved rather than assuming this one, so a future basis
   * cannot pair a chip with a figure the card did not print.
   *
   * ISS-10734 removed the `apiCost` sibling that used to sit above this one: no
   * mode resolved to it after ISS-10636, so no chip could ever be graded with
   * it. The WIRE member it mirrored (`AgentSessionComparisonMetric.ApiCost`) is
   * deliberately still emitted, as version-skew surface.
   */
  totalCost?: SessionSummaryDelta;
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
   * `LOC / $` is the other delivery card and it is still deliberately
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
 *
 * FEA-4201: `customWindowDays` OUTRANKS both, because when an explicit `?from=`/
 * `?to=` window is in charge the producer derives the prior period from THOSE
 * bounds — so a caption read from the preset would name a period the numbers
 * beside it were never computed over ("vs. prior 90 days" over a one-day
 * drill-down), and an `all` preset would suppress chips for a window that does
 * have a prior period. An arbitrary span has no cadence word, so the explicit
 * case always takes the day-count wording whatever the V2 gate says.
 */
export function sessionPriorWindowLabel(
  dateRange: DateRange,
  comparisonV2Enabled = false,
  customWindowDays?: number
): string | null {
  if (customWindowDays !== undefined) {
    return priorDaysLabel(customWindowDays);
  }
  if (dateRange === "all") {
    return null;
  }
  if (comparisonV2Enabled) {
    return GROWTH_LABEL[dateRange];
  }
  return priorDaysLabel(SESSION_RANGE_DAYS[dateRange]);
}

/** "vs. prior 7 days" / "vs. prior day" — one owner, so the two cannot drift. */
function priorDaysLabel(days: number): string {
  return days === 1 ? "vs. prior day" : `vs. prior ${days} days`;
}

/**
 * The read states in which a landed comparison must NOT be rendered.
 *
 * ISS-5809 collapsed the Sessions page to a single usage read, which removes the
 * #4480 hazard this gate originally existed for (grading a landed prior response
 * against the OTHER query's still-cached generation). What remains is simpler and
 * still real: while the read is pending, loading, errored, showing placeholder
 * data, or refetching, the FIGURES on screen are not necessarily the ones the
 * comparison beside them describes — so no chip is honest.
 *
 * ISS-6382: `isPending` is in that list because none of the other four is true
 * for a read held closed by the restore gate on a WARM cache — the observer
 * reports a settled success carrying the previous view's figures, so the chip
 * would grade a scope this mount never read. Callers pass the GATED flag.
 *
 * Named and exported rather than inlined at the call site because it is the one
 * rule the host owns, and inline boolean chains are where a condition silently
 * goes missing.
 */
export function shouldSuppressSessionComparison(
  read: SessionComparisonRead,
  honestLoadingEnabled = false
): boolean {
  if (
    read.isPending ||
    read.isLoading ||
    read.isError ||
    read.isPlaceholderData
  ) {
    return true;
  }
  // ISS-7422: a REVALIDATION of a snapshot already in hand is not evidence about
  // the prior period, and dropping the chip for it is what the reporter saw —
  // a correct comparison replaced by "No prior period" every time a stale range
  // was re-selected or the window regained focus.
  //
  // The `isFetching` arm predates ISS-5809, when the figures and the comparison
  // came from two queries that could land out of step. They now ride ONE
  // response, so a settled (non-placeholder) snapshot is internally consistent
  // for as long as it is on screen, whatever is in flight behind it. The arm is
  // kept flag-off so a build without the gate is unchanged byte-for-byte.
  return honestLoadingEnabled ? false : read.isFetching;
}

/**
 * ISS-7422: is a comparison for the scope on screen actually ON ITS WAY?
 *
 * Deliberately NOT the same question as {@link shouldSuppressSessionComparison},
 * which answers the wider "may a chip be shown at all" and folds an ERRORED read
 * in with the in-flight ones. Reusing that verdict as the pending signal is a
 * distinction-collapse in the opposite direction from the one this ticket fixes:
 * a failed refetch holding last-good data has SETTLED — on a failure — and
 * shimmering it announces a fetch that is not happening and will not resume on
 * its own. So the error arm is excluded here and only here.
 *
 * The two are separate inputs to {@link buildSessionSummaryDeltas} rather than
 * one, because a host can legitimately suppress for a reason that is not pending
 * (a scope-narrowed desktop read, a local-fallback source) and the slot must not
 * claim a wait in those states either.
 *
 * ISS-6382's gated `isPending` IS such a wait — the restore gate has not opened
 * yet, so the comparison is still on its way — and printing the settled sentence
 * over it would be this ticket's own defect wearing the gate's clothes.
 */
export function isSessionComparisonPending(
  read: SessionComparisonRead
): boolean {
  if (read.isError) {
    return false;
  }
  return (
    read.isPending ||
    read.isLoading ||
    read.isPlaceholderData ||
    read.isFetching
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
  pending = false,
  comparisonV2Enabled = false,
  customWindowDays,
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
   * ISS-7422: is the comparison for this scope actually IN FLIGHT? Read from
   * {@link isSessionComparisonPending}, which excludes the errored arm that
   * `suppressed` includes, so only a genuine wait renders the pending
   * affordance. Ignored unless `suppressed` is also set — a read that is
   * refetching over a snapshot we may still show keeps its chip.
   */
  pending?: boolean;
  /**
   * FEA-4202's rollout gate, resolved by the HOST and passed in rather than read
   * here, because this module is also imported by mount sites with no flag
   * provider. Default OFF, so every existing caller keeps the ISS-5315 behavior
   * exactly. It was the shared `grid-table-v2` key until ISS-10301 retired that
   * ENABLED; the listing surface now passes `true` unconditionally.
   *
   * ON it turns on the two perceivable additions together — they are one
   * change: the cadence captions (`WoW`/`MoM`/`QoQ`) and the `PRs Shipped`
   * chip. It never relaxes an honesty rule; a gate that could manufacture a
   * delta would defeat the point of the module.
   */
  comparisonV2Enabled?: boolean;
  /**
   * FEA-4201 — the inclusive day count of the explicit `?from=`/`?to=` window,
   * when one is in charge. Present ⇒ it names the compared period instead of
   * `dateRange`; see {@link sessionPriorWindowLabel}.
   */
  customWindowDays?: number;
}): SessionSummaryDeltas {
  const label = sessionPriorWindowLabel(
    dateRange,
    comparisonV2Enabled,
    customWindowDays
  );
  // The gate rides the RETURNED object, not just the entries it emits, because
  // the delivery pair's perceivable addition is its placeholder as much as its
  // chip — and the placeholder is exactly what the "no honest comparison" paths
  // below return. Carrying it on both return paths keeps a flag-off build's
  // delivery footer unchanged in every one of those states, not only the ones
  // that reach an entry (review threads on #4681).
  const deliveryCompared = comparisonV2Enabled;
  const deltas = current?.comparison?.deltas;
  // "All time" has no window before it. That is a settled fact about the RANGE
  // rather than about any read, so it outranks the pending arm below: a card
  // here says "No prior period" even mid-flight, because no response is going to
  // change it.
  if (label === null) {
    return { deliveryCompared, label };
  }
  // ISS-7422: the comparison for this scope is NOT KNOWN YET — distinct from the
  // settled absence below, which is a claim the producer has actually made.
  // Collapsing the two is the reported defect: every suppressed read printed the
  // settled "No prior period" over figures whose comparison was still arriving.
  //
  // `pending` is asked SEPARATELY from `suppressed` on purpose. A suppressed read
  // is not necessarily an arriving one — an errored refetch holding last-good
  // data has settled on a failure — and marking that pending would trade this
  // ticket's false claim for the mirror-image one.
  if (suppressed) {
    return pending
      ? { deliveryCompared, label, pending: true }
      : { deliveryCompared, label };
  }
  // ISS-7525: the comparison rode this response, so a prior window was actually
  // measured — which is what makes an empty slot below a DECLINED comparison
  // rather than an absent prior period. Read from the comparison OBJECT, not
  // from its entries: a card with no entry is exactly the case that has to be
  // told apart, so keying this on the entries would answer the question with
  // itself. Ungated, because it is a fact about the payload; the flag decides
  // only how the slot renders it.
  const result: SessionSummaryDeltas =
    current?.comparison === undefined
      ? { deliveryCompared, label }
      : { deliveryCompared, label, priorPeriodMeasured: true };
  if (!deltas) {
    return result;
  }
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
  // a spend figure carries everywhere else in the product.
  assignDelta(
    result,
    "totalCost",
    deltas.totalCost,
    MetricPolarity.LowerIsBetter
  );
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
/**
 * The keys of {@link SessionSummaryDeltas} that actually carry a delta entry,
 * DERIVED rather than hand-listed. The wire enum
 * (`AgentSessionComparisonMetric`) is deliberately wider — it still emits
 * `MeteredCost` as version-skew surface after ISS-8791 retired the client basis
 * that read it — so keying this on the wire type would let a metric no client
 * field can hold compile here and fail at the index. Deriving it means the
 * client type is the single inventory: drop a field and every `assignDelta`
 * call for it fails `tsc`.
 */
type SessionSummaryDeltaKey = {
  [K in keyof SessionSummaryDeltas]-?: SessionSummaryDeltas[K] extends
    | SessionSummaryDelta
    | undefined
    ? K
    : never;
}[keyof SessionSummaryDeltas];

function assignDelta(
  target: SessionSummaryDeltas,
  key: SessionSummaryDeltaKey,
  delta: number | undefined,
  deltaPolarity: MetricPolarity
): void {
  if (typeof delta !== "number") {
    return;
  }
  target[key] = { delta, deltaPolarity };
}

/**
 * The query read-state the two comparison gates above grade a summary payload
 * against. Named so a caller that renders a payload from somewhere other than a
 * live observer — a restored snapshot, say — can state that payload's own
 * settledness instead of reconstructing five booleans at the call site.
 */
export type SessionComparisonRead = {
  isPending: boolean;
  isLoading: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  isFetching: boolean;
};
