import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import {
  formatCostMetricDetail,
  formatHonestCostMetricDetail,
  SESSIONS_COST_HONEST_METRIC_CARD_INFO,
  SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_INFO,
  SESSIONS_COST_METRIC_CARD_LABEL,
  SESSIONS_COST_NO_COST_RECORDED_DETAIL,
} from "./cost-metric-card";

/**
 * Which basis the Sessions Cost card reports on, and the caption that goes with
 * it (ISS-4773).
 *
 * Extracted from `sessions-summary-cards.tsx` when the ISS-4773 review hardened
 * the split validation: the component was already at the file-size ceiling, and
 * "which spend may this card stand behind" is one cohesive concern that the
 * component only renders. Keeping it here means the label, the headline value,
 * the info copy and the caption are decided in ONE place and can never describe
 * different numbers.
 */

/**
 * Tolerance for the `metered + unknown === api` reconciliation.
 *
 * The three figures are independently accumulated floats (the desktop ledger
 * folds three buckets; the cloud producer sums a groupBy), so exact equality is
 * not a fair test — the halves and the collapsed bucket routinely differ in the
 * last ULP. Relative, not absolute, so a large account is not failed for drift
 * that is proportionally invisible, with an absolute floor so a near-zero total
 * does not demand impossible precision. Well below a displayed cent either way.
 */
const COST_RECONCILIATION_RELATIVE_TOLERANCE = 1e-6;
const COST_RECONCILIATION_ABSOLUTE_TOLERANCE = 1e-6;

/**
 * ISS-4773 (wongk + stage review) — may this payload's three-way split be
 * reported as confirmed spend?
 *
 * `meteredEstimatedCost` and `unknownEstimatedCost` are INDEPENDENTLY optional on
 * the contract, and both the HTTP response and the Desktop IPC reply are trusted
 * at runtime rather than parsed. Gating on `meteredEstimatedCost` alone therefore
 * accepted a metered-only payload: the card entered honest mode, headlined the
 * metered figure, and `formatHonestCostMetricDetail` then dropped the very
 * disclosure clause the flag exists to add — understating the population with no
 * signal at all, which is the exact failure the flag was written to prevent.
 *
 * So this requires BOTH halves, and requires them to be real: `null` (which the
 * optional type does not admit but a wire payload can still carry) is rejected
 * along with non-finite and negative values, and the two halves must reconcile
 * with the collapsed `apiEstimatedCost` they claim to partition. An unreconciled
 * split is a producer bug or a version-skew shape we do not understand; either
 * way the card falls back to the shipped presentation, which at least names the
 * bucket it is summing, rather than presenting a headline it cannot substantiate.
 */
export function hasReportableCostSplit(
  usage: AgentSessionUsageSummary
): boolean {
  const metered = usage.meteredEstimatedCost;
  const unknown = usage.unknownEstimatedCost;
  if (!(isReportableCostValue(metered) && isReportableCostValue(unknown))) {
    return false;
  }
  const api = usage.apiEstimatedCost;
  if (!Number.isFinite(api)) {
    return false;
  }
  const drift = Math.abs(metered + unknown - api);
  const tolerance = Math.max(
    COST_RECONCILIATION_ABSOLUTE_TOLERANCE,
    Math.abs(api) * COST_RECONCILIATION_RELATIVE_TOLERANCE
  );
  return drift <= tolerance;
}

/**
 * A cost figure this card may stand behind: present, a real number, finite, and
 * not negative. `null` is checked explicitly — the field is typed optional, but
 * this value arrives over HTTP and over Desktop IPC without being parsed, and a
 * `null` there must degrade to the fallback presentation rather than sum as 0.
 */
function isReportableCostValue(
  value: number | null | undefined
): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/**
 * ISS-4773 — which basis the Sessions Cost card reports on, resolved ONCE so the
 * label, the headline value, the info copy and the caption can never describe
 * different numbers.
 *
 * Honest mode requires BOTH the flag AND a producer that actually sent a usable
 * three-way split (see `hasReportableCostSplit`). The split is optional on the
 * contract for version skew: an already-installed Desktop predating ISS-4773
 * published only the collapsed `apiEstimatedCost` bucket. Treating that absence
 * as `0` would swap one lie for a worse one — a confident "$0 billed" for an
 * account that may have spent thousands — so a producer that cannot split the
 * bucket falls back to the shipped presentation, which at least names the bucket
 * it is summing ("cost"). This is the graceful-degradation rule
 * for version-skewed peers, applied to a money surface.
 *
 * In honest mode the headline is `meteredEstimatedCost` — CONFIRMED API-billed
 * spend — under its OWN label, never the bare word "Cost" (see
 * `SESSIONS_COST_HONEST_METRIC_CARD_LABEL`). Unclassified usage is excluded from
 * the headline (so the card stops overstating out-of-pocket cost) and disclosed
 * on the caption instead (so the card does not understate the population
 * either); see `formatHonestCostMetricDetail`.
 */
export function resolveCostCardPresentation(
  honestyEnabled: boolean,
  usage: AgentSessionUsageSummary | undefined
): {
  honest: boolean;
  cost: number | undefined;
  label: string;
  info: { what: string; how?: string };
} {
  // `usage === undefined` is "not loaded yet", NOT "cannot split": the card
  // keeps its label/info chrome while the value slot skeletons, so deciding
  // against the honest presentation here would render "cost"
  // during the load and swap it on arrival — the label flicker reads as the card
  // changing what it measures. Only a SETTLED payload that lacks a usable split
  // falls back.
  const honest =
    honestyEnabled && (usage === undefined || hasReportableCostSplit(usage));
  if (honest) {
    return {
      honest: true,
      cost: usage?.meteredEstimatedCost,
      label: SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
      info: SESSIONS_COST_HONEST_METRIC_CARD_INFO,
    };
  }
  return {
    honest: false,
    cost: usage?.apiEstimatedCost,
    label: SESSIONS_COST_METRIC_CARD_LABEL,
    info: SESSIONS_COST_METRIC_CARD_INFO,
  };
}

/**
 * ISS-5401 — could NOTHING in this matched cohort be priced?
 *
 * The aggregate analogue of `deriveCostAvailability`'s `Unavailable` verdict
 * (`packages/app/agents/lib/cost-availability.ts`): a session that did
 * measurable work but carries no priced cost renders `—` in the Cost COLUMN. The
 * tile summed those exact rows in as `0` and headlined a confident `$0`, which
 * made "we could not compute this" indistinguishable from "these sessions cost
 * nothing" — the reported `6,535 · 1.26B · $0` signature, 1.26 billion tokens
 * beside a zero.
 *
 * ANALOGUE, not twin: the row predicate sees per-session billing mode and a
 * reconciled cost, and this one sees neither. It agrees with the column on the
 * cohort this ticket is about and can disagree on two others — see the known
 * limit at the bottom of this block.
 *
 * The discriminator needs no new wire field. `totalEstimatedCost` is the
 * subscription-INCLUSIVE grand total (FEA-3986), so a cohort that consumed
 * tokens and yet has NO money in ANY of its five figures priced nothing at all.
 * A subscription-covered cohort is not caught: its spend lands in
 * `subscriptionEstimatedCost`, so its `apiEstimatedCost: 0` headline stays the
 * genuine zero it is (and keeps its "+$X if billed to API" caption).
 *
 * Deliberately conservative in three ways, because dashing a real number is its
 * own lie:
 *  - an unsettled payload (`undefined`) is "not known yet", never "unpriceable";
 *  - a cohort with no tokens at all is a genuine/empty zero and keeps `$0`;
 *  - ANY single figure carrying real money — including one a version-skewed
 *    producer sent while omitting its siblings — proves pricing worked for part
 *    of the cohort and takes the tile straight off this path.
 *
 * The token totals are the load-bearing half of that last guard. A producer that
 * publishes no usage at all reads as a no-token cohort, so a payload we cannot
 * interpret degrades to the shipped `$0`/`—` presentation rather than to a dash
 * this module invented.
 *
 * A PARTIALLY unpriced cohort still headlines its real subtotal: with only
 * aggregates in hand there is no unpriced-session count to caveat it with. That
 * disclosure needs an additive producer signal and is tracked separately.
 *
 * KNOWN LIMIT, deliberately accepted (logical-QA audit). This says "no matched
 * session carried a cost figure", which is not always the same as "the cohort
 * had no cost". Two audited cohorts dash here while the rows beneath show a
 * figure — and they are NOT the same kind of miss, so they are scored
 * separately (stage review on #4667, which correctly rejected the single
 * blanket justification this block used to carry):
 *
 *  1. a legacy session whose stored `estimatedCost` rollup is zero but whose
 *     priced per-event stream is not. The LIST reconciles that stream — the
 *     CLOUD `reconcileSessionCost` (`apps/api/app/agent-sessions/service/
 *     cost-authority.ts`, batched per page by `getReconciledCostsBySessionId`
 *     and applied in `projections.ts`, FEA-4276), NOT the same-named desktop
 *     import-time collector in `apps/desktop/src/main/cost/usage-reconciliation.ts`
 *     — while this summary sums the RAW column (`computeSessionCostSplit` runs
 *     a `groupBy(_sum: estimatedCost)` over `sessionDetail`), so the two
 *     genuinely hold different numbers for the same row. Here the dash is the
 *     LESS wrong render: the shipped `$0` tile was already contradicting a row
 *     showing real dollars, and was quieter about it. Filed as ISS-5609.
 *
 *  2. a subscription-covered session whose API-equivalent price could not be
 *     computed — `deriveCostAvailability` checks billing mode before it asks
 *     whether anything was priced, so the cell renders `$0.00` with the "Billed
 *     through your subscription" tooltip. This one is a REGRESSION in
 *     same-screen agreement, stated plainly rather than folded into the
 *     sentence above: the shipped `$0` headline MATCHED that column, and the
 *     dash does not. Accepted anyway, because agreeing with a cell that itself
 *     asserts a measured `$0.00` for usage nothing could price is agreement on
 *     a fabricated number — the exact trade this ticket exists to make — and
 *     because the caption never claims the cohort was free, only that no cost
 *     was recorded. The CELL is the side that should move — `formatCostLabel`
 *     should not print `$0.00` for a Subscription row that priced nothing — and
 *     that lives in `cost-availability.ts`, which #4642 is already rewriting,
 *     so it is deliberately not forked here.
 *
 * Both are upstream divergences this predicate surfaces rather than causes. The
 * caption is worded to the claim the tile can actually substantiate (see
 * `SESSIONS_COST_NO_COST_RECORDED_DETAIL`), and both upstream gaps are filed.
 */
export function isCohortCostUnpriceable(
  usage: AgentSessionUsageSummary | undefined
): boolean {
  if (usage === undefined) {
    return false;
  }
  // ISS-5401 (wongk review): a cohort that provably consumed NOTHING is a
  // genuine/empty zero and keeps `$0`. Corrupt counters are NOT that cohort —
  // they are no evidence either way, so they must not buy a confident `$0`
  // (see {@link resolveTokenUsageEvidence}) and fall through to the cost check.
  if (resolveTokenUsageEvidence(usage) === TokenUsageEvidence.Empty) {
    return false;
  }
  const costFigures = [
    usage.totalEstimatedCost,
    usage.apiEstimatedCost,
    usage.subscriptionEstimatedCost,
    usage.meteredEstimatedCost,
    usage.unknownEstimatedCost,
  ];
  // ISS-5401 (wongk review): every figure must be READABLE before the absence of
  // money in them can mean anything. A `null` grand total (the type says
  // `number`, but neither producer's payload is parsed) or a negative sibling is
  // a figure we cannot interpret, not a zero — and "no cost recorded" over an
  // unknown total is the same fabrication as `$0` over one, pointed the other
  // way. An uninterpretable payload degrades to the shipped presentation, which
  // is this module's standing rule for a producer it does not understand.
  if (!costFigures.every(isInterpretableCostFigure)) {
    return false;
  }
  return !costFigures.some(isNonZeroCostFigure);
}

/**
 * What the cohort's token counters actually prove (ISS-5401, wongk review).
 *
 * Three outcomes, not two, because "zero" and "unreadable" are different facts
 * and only one of them licenses a confident `$0`.
 */
const TokenUsageEvidence = {
  /** At least one counter is a real, positive figure: work happened. */
  Measured: "measured",
  /** Every counter is a real zero: the cohort genuinely consumed nothing. */
  Empty: "empty",
  /** A counter is absent, non-finite, or negative — this proves nothing. */
  Uninterpretable: "uninterpretable",
} as const;
type TokenUsageEvidence =
  (typeof TokenUsageEvidence)[keyof typeof TokenUsageEvidence];

/**
 * Did the matched cohort consume any tokens? The aggregate stand-in for
 * `isSubstantiveSession`'s per-row work signal — the summary carries no turn or
 * tool-use totals, so tokens are the evidence available at this layer. All four
 * counters are checked (cache reads/writes included) for the same reason the row
 * predicate checks them: cached usage is still usage that should have been
 * priced.
 *
 * ISS-5401 (wongk review) — `Empty` is claimed ONLY for counters that are all
 * real, finite, non-negative zeros. It used to be the mere absence of a positive
 * one, which quietly folded a corrupt payload (`totalInputTokens: -1`, the rest
 * zero) into "this cohort consumed nothing" and handed it back the exact
 * confident `$0` this ticket removes. A corrupt counter is not a measured empty
 * cohort; it is no measurement at all, and the tile must not spend it on a
 * claim about money.
 */
function resolveTokenUsageEvidence(
  usage: AgentSessionUsageSummary
): TokenUsageEvidence {
  const tokenTotals = [
    usage.totalInputTokens,
    usage.totalOutputTokens,
    usage.totalCacheReadTokens,
    usage.totalCacheWriteTokens,
  ];
  if (!tokenTotals.every(isInterpretableTokenTotal)) {
    return TokenUsageEvidence.Uninterpretable;
  }
  return tokenTotals.some((total) => total > 0)
    ? TokenUsageEvidence.Measured
    : TokenUsageEvidence.Empty;
}

/**
 * A token counter this predicate may reason about: present, a real number,
 * finite, and not negative. A negative token count is nonsense no producer means
 * literally, so it is read as corruption rather than as "fewer than none".
 */
function isInterpretableTokenTotal(
  value: number | null | undefined
): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/**
 * A cost figure whose VALUE this predicate may reason about — including the
 * absent case.
 *
 * `undefined` passes deliberately: `meteredEstimatedCost` and
 * `unknownEstimatedCost` are optional on the contract precisely so a Desktop
 * predating ISS-4773 can publish only the collapsed bucket, and rejecting that
 * absence would make this whole path dead for every version-skewed peer. What is
 * rejected is a figure that is PRESENT and unusable: `null` (which the optional
 * type does not admit but an unparsed wire payload still carries), non-finite,
 * or negative. The negative case is the one that mattered most — it used to
 * satisfy {@link isNonZeroCostFigure} below as "real money", so a `-5` counted
 * as proof that pricing had worked, while {@link isReportableCostValue} two
 * screens up rejects the same value for the same reason. One module, two answers
 * about the same figure.
 */
function isInterpretableCostFigure(value: number | null | undefined): boolean {
  return value === undefined || isReportableCostValue(value);
}

/**
 * Is this cost figure real money rather than an absent or zero one? Any single
 * non-zero figure proves pricing succeeded for part of the cohort, which takes
 * the tile off the unpriceable path. Only reached once every figure has passed
 * {@link isInterpretableCostFigure}, so a non-finite or negative value can no
 * longer arrive here dressed as evidence.
 */
function isNonZeroCostFigure(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(value) && value !== 0;
}

/**
 * ISS-5401 — the Cost tile's value, caption and movement slot, decided together.
 *
 * Lifted out of `AlwaysAvailableCards` (which was at the cognitive-complexity
 * ceiling, in a file near the size ceiling) because the tile now has THREE
 * reasons to withhold a figure and they have to agree with each other: a failed
 * read, the ISS-4481 Unknown cost facet, and a cohort carrying no cost at all.
 * Resolving them here means the headline, the caption and the chip beside them
 * can never disagree about whether this card has a number.
 *
 * The three are not interchangeable. A failed read and the facet case both
 * withhold the caption too — the first has nothing true to say, the second
 * already said it through the filter the reader set. The no-cost case is the one
 * that OWES an explanation, because the reader did nothing to cause it.
 *
 * ISS-5842: this no longer returns a `warn` escalation flag. The dominant-unknown
 * case used to flip the caption to the row's amber `TriangleAlertIcon` treatment;
 * product removed that (Mike, 2026-08-10) because a subscription-covered figure
 * and an unclassified figure are FACTS ABOUT THE ACCOUNT, not faults the reader
 * can act on, and warning colour is a call to action there is no action for. The
 * caption still states both shares — only its tone changed, to the card's
 * ordinary muted caption.
 */
export function resolveCostTileSlots({
  cardsLoading,
  costPresentation,
  costUnknownActive,
  errored,
  loadingDetail,
  localFallbackDetail,
  showingLocalFallback,
  usage,
}: {
  cardsLoading: boolean;
  costPresentation: ReturnType<typeof resolveCostCardPresentation>;
  costUnknownActive: boolean;
  errored: boolean;
  loadingDetail: string;
  localFallbackDetail: string;
  showingLocalFallback: boolean;
  usage: AgentSessionUsageSummary | undefined;
}): {
  cost: number | null | undefined;
  detail: string | undefined;
  dashed: boolean;
} {
  // Gated on a SETTLED, non-errored read: those two states own the value slot
  // already, and an unsettled payload is "not known yet", not "no cost data".
  const unpriceable =
    !(cardsLoading || errored) && isCohortCostUnpriceable(usage);
  // ISS-4481: when the active Cost facet is Unknown, every listed row renders
  // "—", so the aggregate must NOT sum that all-unknown cohort to a fabricated
  // "$0". ISS-5401 routes the no-cost cohort to the SAME honest-empty dash.
  const dashed = errored || costUnknownActive || unpriceable;
  const detail = costUnknownActive
    ? undefined
    : resolveCostCardDetail({
        loading: cardsLoading,
        loadingDetail,
        localFallbackDetail,
        errored,
        showingLocalFallback,
        usage,
        honest: costPresentation.honest,
        unpriceable,
      });
  const cost = dashed ? null : costPresentation.cost;
  return { cost, dashed: dashed || !isRenderableCost(cost), detail };
}

/**
 * ISS-5401 (wongk review) — will the card actually PAINT this figure, or fall
 * through to its honest-empty glyph?
 *
 * The three withhold reasons above are not the only way the headline dashes.
 * `CostMetricCard` routes every value through `formatCurrencyTileValue`, which
 * emits `—` for anything nullish or non-finite — so a payload with real money in
 * a SIBLING field but a `null`/`NaN` in the one the resolved presentation
 * headlines (`apiEstimatedCost` on the shipped basis, `meteredEstimatedCost` on
 * the honest one) renders a dash while every reason flag is false. The wire
 * types say `number`, but neither the HTTP response nor the Desktop IPC reply is
 * parsed, and this module already has a regression pinning that exact shape.
 *
 * That mattered because the caller reads `dashed` to decide whether a movement
 * may sit beneath the value (`deltaSlotProps` / `deltaPlaceholder`). Left as the
 * reason-flags alone, that case put a signed "-40%" chip under an unavailable
 * headline — grading a period movement in a number the card never stated, which
 * is the one thing the ISS-5401 delta suppression exists to prevent. So `dashed`
 * now means what its consumers assume it means: the value slot is empty.
 *
 * Deliberately the SAME predicate `formatCurrencyTileValue` applies, so the flag
 * and the render can never disagree about whether there is a number on screen.
 */
function isRenderableCost(cost: number | null | undefined): boolean {
  return cost != null && Number.isFinite(cost);
}

/**
 * FEA-4128 / ISS-4429: the Cost card's detail line across the always-available
 * states. While hydrating, the honest wait caption (import vs plain loading, from
 * the caller); on a failed local read, no caption (the value dashes); otherwise
 * the share(s) that sit outside the headline.
 *
 * ISS-4773 (wongk review): the LOCAL-fallback path composes rather than
 * replaces. It used to return the bare provenance caption, which on a cloud
 * failure left an honest-mode card headlining metered-only spend with NO mention
 * of the subscription and unclassified shares it had just excluded — the card
 * hiding exactly the amount it dropped, at the moment the reader is least able to
 * check it. Provenance and disclosure answer different questions ("where is this
 * number from" vs "what is not in it"), so both are stated.
 */
export function resolveCostCardDetail({
  loading,
  loadingDetail,
  localFallbackDetail,
  errored,
  showingLocalFallback,
  usage,
  honest,
  unpriceable,
}: {
  loading: boolean;
  loadingDetail: string;
  localFallbackDetail: string;
  errored: boolean;
  showingLocalFallback: boolean;
  usage: AgentSessionUsageSummary | undefined;
  /**
   * ISS-4773: the card resolved to its honest presentation (flag ON AND the
   * producer sent a usable three-way split), so the caption also discloses the
   * unclassified share. Decided ONCE by `resolveCostCardPresentation` and passed
   * in, never re-derived here — a second copy of that predicate could caption a
   * headline computed on the other basis.
   */
  honest: boolean;
  /**
   * ISS-5401: nothing in the matched cohort could be priced, so the headline
   * dashed. The caption says WHY — an uncaptioned `—` is indistinguishable from
   * the failed-read dash directly above it. Decided ONCE by
   * {@link isCohortCostUnpriceable} and passed in, never re-derived here.
   */
  unpriceable: boolean;
}): string | undefined {
  if (loading) {
    return loadingDetail;
  }
  if (errored) {
    return undefined;
  }
  const caption = resolveCostCaption({ honest, unpriceable, usage });
  if (!showingLocalFallback) {
    return caption;
  }
  return caption === undefined
    ? localFallbackDetail
    : `${localFallbackDetail} · ${caption}`;
}

/**
 * The fact the Cost caption states beneath a settled headline, before the
 * local-fallback provenance is composed onto it.
 *
 * ISS-5401's reason caption REPLACES the excluded-share clauses rather than
 * joining them: on the unpriceable path every one of those shares is zero, so
 * they render nothing anyway, and the only fact left worth stating is why the
 * headline is a dash.
 */
function resolveCostCaption({
  honest,
  unpriceable,
  usage,
}: {
  honest: boolean;
  unpriceable: boolean;
  usage: AgentSessionUsageSummary | undefined;
}): string | undefined {
  if (unpriceable) {
    return SESSIONS_COST_NO_COST_RECORDED_DETAIL;
  }
  if (honest) {
    return formatHonestCostMetricDetail(
      usage?.subscriptionEstimatedCost,
      usage?.unknownEstimatedCost
    );
  }
  return formatCostMetricDetail(usage?.subscriptionEstimatedCost);
}
