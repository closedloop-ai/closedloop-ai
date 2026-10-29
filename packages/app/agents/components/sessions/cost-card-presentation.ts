import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import {
  TOTAL_ESTIMATED_COST_ALIAS_LABEL,
  TOTAL_ESTIMATED_COST_COPY,
} from "@repo/api/src/types/total-estimated-cost-copy";
import { SESSIONS_COST_NO_COST_RECORDED_DETAIL } from "./cost-metric-card";

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
 * ISS-4773 (whitlockk + stage review) — may this payload's three-way split be
 * reported as confirmed spend?
 *
 * `meteredEstimatedCost` and `unknownEstimatedCost` are INDEPENDENTLY optional on
 * the contract, and both the HTTP response and the Desktop IPC reply are trusted
 * at runtime rather than parsed. Gating on `meteredEstimatedCost` alone therefore
 * accepted a metered-only payload, which under the since-retired honest
 * presentation headlined the metered figure while silently dropping the
 * disclosure clause that named what it excluded (ISS-8791 removed that mode; the
 * defect is recorded because this predicate is what still prevents it).
 *
 * So this requires BOTH halves, and requires them to be real: `null` (which the
 * optional type does not admit but a wire payload can still carry) is rejected
 * along with non-finite and negative values, and the two halves must reconcile
 * with the collapsed `apiEstimatedCost` they claim to partition. An unreconciled
 * split is a producer bug or a version-skew shape we do not understand; either
 * way the card drops its lanes and headlines the total alone, rather than
 * stating a partition it cannot substantiate.
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
 * ISS-4748 — which basis the Sessions Cost card reports on. A named mode rather
 * than a boolean, so the set cannot produce an undefined state, and every
 * consumer that switches on the basis (the label, the headline
 * value, the info copy, the caption, the delta entry, the lanes) reads ONE
 * resolved answer rather than re-deriving it from the flags.
 */
export const CostCardPresentationMode = {
  /** ISS-4748: headline the subscription-inclusive total, state all lanes. */
  Breakdown: "breakdown",
  /**
   * ISS-9969: headline the subscription-inclusive total with NO lanes — the
   * producer could not stand behind a partition, but the total is still the
   * only figure this card may state.
   */
  Total: "total",
} as const;
export type CostCardPresentationMode =
  (typeof CostCardPresentationMode)[keyof typeof CostCardPresentationMode];

export type CostCardPresentation = {
  mode: CostCardPresentationMode;
  cost: number | undefined;
  label: string;
  info: { what: string; how?: string };
};

/**
 * ISS-4748 — whether BREAKDOWN mode can stand behind all three lanes.
 *
 * Strictly stronger than {@link hasReportableCostSplit}, which reconciles
 * `metered + unknown` against `apiEstimatedCost` and says nothing about the
 * subscription lane or the total (whitlockk, #5953). A payload with a valid API
 * split but a mismatched total, or a negative subscription figure, passed that
 * check, entered breakdown mode, and then had a lane rewritten by the
 * whole-dollar allocator to fit a header it never summed to.
 *
 * Breakdown headlines the TOTAL and states all three lanes as a partition of it,
 * so the precondition is the partition itself: three real, non-negative,
 * finite figures that reconcile with the total they claim to make up. Anything
 * short of that falls back, exactly as an unsplittable producer does.
 */
function canReportCostBreakdown(
  usage: AgentSessionUsageSummary | undefined
): boolean {
  if (usage === undefined) {
    return true;
  }
  // ISS-5401 ∩ ISS-8791: a cohort that did measurable work and priced NOTHING
  // partitions cleanly into three zeroes, so every arithmetic check below
  // passes and the card would state `$0 · $0 · $0` as a measured partition. That
  // makes "we could not compute this" indistinguishable from "these sessions
  // cost nothing" — the conflation ISS-5401 exists to stop — and breakdown also
  // suppresses the reason caption that would have explained the dash, so the
  // tile loses its only signal. Refusing here routes the cohort back to a mode
  // that keeps the reason. Latent while breakdown was flagged OFF; universal
  // once ISS-8791 retired the flag.
  if (isCohortCostUnpriceable(usage)) {
    return false;
  }
  if (!hasReportableCostSplit(usage)) {
    return false;
  }
  const lanes = [
    usage.meteredEstimatedCost,
    usage.subscriptionEstimatedCost,
    usage.unknownEstimatedCost,
  ];
  if (!lanes.every(isReportableCostValue)) {
    return false;
  }
  const total = usage.totalEstimatedCost;
  if (!(typeof total === "number" && Number.isFinite(total) && total >= 0)) {
    return false;
  }
  const laneSum = lanes.reduce<number>((sum, lane) => sum + (lane ?? 0), 0);
  const tolerance = Math.max(
    COST_RECONCILIATION_ABSOLUTE_TOLERANCE,
    Math.abs(total) * COST_RECONCILIATION_RELATIVE_TOLERANCE
  );
  return Math.abs(laneSum - total) <= tolerance;
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
 * ANALOGUE, not twin: the row predicate sees ONE session's billing mode and
 * that session's own stored cost, and this one sees only cohort aggregates, so
 * it can ask neither question per session. It agrees with the column on the
 * cohort this ticket is about and can still disagree with it on one other — see
 * the known limit at the bottom of this block.
 *
 * The discriminator needs no new wire field. `totalEstimatedCost` is the
 * subscription-INCLUSIVE grand total (FEA-3986), so a cohort that consumed
 * tokens and yet has NO money in ANY of its five figures priced nothing at all.
 * A subscription-covered cohort is not caught: its spend lands in
 * `subscriptionEstimatedCost`, which the inclusive total this card headlines
 * already contains — so it states that real figure rather than a zero.
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
 * interpret keeps its `$0`/`—` rather than taking a dash this module invented.
 *
 * A PARTIALLY unpriced cohort still headlines the total it could price: with
 * only aggregates in hand there is no unpriced-session count to caveat it with.
 * That disclosure needs an additive producer signal and is tracked separately.
 *
 * THE REMAINING DISPLAY SPLIT, in one account. Row and tile read the SAME
 * stored figure — `session_detail.estimated_cost`, projected per row by
 * `projections.ts` and summed for the cohort here by `computeSessionCostSplit`
 * (a `groupBy` with `_sum: estimatedCost` over `sessionDetail`). Since ISS-7176
 * there is no second cost for them to disagree about, so what can still differ
 * is not the NUMBER but what each side RENDERS from it, and exactly one cohort
 * is left where they render it differently.
 *
 * KNOWN LIMIT, deliberately accepted (logical-QA audit, stage review on #4667).
 * This says "no matched session carried a cost figure", which is not always the
 * same as "the cohort had no cost". A subscription-covered session whose
 * API-equivalent price could not be computed dashes here while the row beneath
 * it shows a figure: `deriveCostAvailability` is handed that stored
 * `estimatedCost` and checks billing mode BEFORE it asks whether anything was
 * priced, so a `Subscription` verdict prints `formatCost(0)` — `$0.00`, with
 * the "Billed through your subscription" tooltip — while the same all-zero
 * figures put the cohort on this predicate's dash. That is a REGRESSION in
 * same-screen agreement: the `$0` headline this predicate replaced MATCHED that
 * column, and the dash does not. Accepted anyway, because agreeing with a cell that itself
 * asserts a measured `$0.00` for usage nothing could price is agreement on a
 * fabricated number — the exact trade this ticket exists to make — and because
 * the caption never claims the cohort was free, only that no cost was recorded.
 *
 * The CELL is the side that should move: `formatCostLabel` should not print
 * `$0.00` for a Subscription row that priced nothing. That decision belongs to
 * `cost-availability.ts` and is deliberately not forked here. No ticket owns it
 * as of 2026-09-14 — this block is the only record of it, which is why the
 * paragraph above states the trade rather than pointing at a slug. The caption
 * meanwhile is worded to the claim the tile can actually substantiate (see
 * `SESSIONS_COST_NO_COST_RECORDED_DETAIL`).
 */
export function isCohortCostUnpriceable(
  usage: AgentSessionUsageSummary | undefined
): boolean {
  if (usage === undefined) {
    return false;
  }
  // ISS-5401 (whitlockk review): a cohort that provably consumed NOTHING is a
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
  // ISS-5401 (whitlockk review): every figure must be READABLE before the absence of
  // money in them can mean anything. A `null` grand total (the type says
  // `number`, but neither producer's payload is parsed) or a negative sibling is
  // a figure we cannot interpret, not a zero — and "no cost recorded" over an
  // unknown total is the same fabrication as `$0` over one, pointed the other
  // way. An uninterpretable payload keeps its figure rather than taking a dash,
  // which is this module's standing rule for a producer it does not understand.
  if (!costFigures.every(isInterpretableCostFigure)) {
    return false;
  }
  return !costFigures.some(isNonZeroCostFigure);
}

/**
 * What the cohort's token counters actually prove (ISS-5401, whitlockk review).
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
 * ISS-5401 (whitlockk review) — `Empty` is claimed ONLY for counters that are all
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
 * product removed that (Marisol, 2026-08-10) because a subscription-covered figure
 * and an unclassified figure are FACTS ABOUT THE ACCOUNT, not faults the reader
 * can act on, and warning colour is a call to action there is no action for.
 *
 * The share-stating caption that replaced it is gone too: ISS-4748 / ISS-9969
 * folded the subscription share into the headline, so the only caption this
 * slot still emits is ISS-5401's `No cost recorded`.
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
  settledEmpty: boolean;
} {
  // Gated on a SETTLED, non-errored read: those two states own the value slot
  // already, and an unsettled payload is "not known yet", not "no cost data".
  const unpriceable =
    !(cardsLoading || errored) && isCohortCostUnpriceable(usage);
  // ISS-4481: when the active Cost facet is Unknown, every listed row renders
  // "—", so the aggregate must NOT sum that all-unknown cohort to a fabricated
  // "$0". ISS-5401 routes the no-cost cohort to that SAME honest-empty dash.
  const dashed = errored || costUnknownActive || unpriceable;
  const detail = costUnknownActive
    ? undefined
    : resolveCostCardDetail({
        loading: cardsLoading,
        loadingDetail,
        localFallbackDetail,
        errored,
        showingLocalFallback,
        unpriceable,
      });
  const cost = dashed ? null : costPresentation.cost;
  // `dashed` is the union of FOUR reasons the card shows no number, and only one
  // of them is an honest, settled "there is no cost to state". Anything keyed off
  // the union — a hide gate above all — would also swallow:
  //   - `errored`, a failed read;
  //   - `costUnknownActive`, the READER'S OWN active facet, where every listed
  //     row is dashed by their filter and the card is answering them correctly
  //     (whitlockk, #6885);
  //   - `!isRenderableCost(cost)`, a settled but MALFORMED headline while another
  //     cost field still holds real money — the version-skew contradiction this
  //     resolver dashes precisely to expose (codex, #6885).
  // So the honest-empty state is published POSITIVELY rather than inferred, and
  // the corrupt and reader-driven cases keep their dash on screen where the
  // reader can see something is wrong.
  const settledEmpty = isSettledEmptyCost({
    cardsLoading,
    costUnknownActive,
    errored,
    usage,
  });
  return {
    cost,
    dashed: dashed || !isRenderableCost(cost),
    detail,
    settledEmpty,
  };
}

/**
 * ISS-5401 (whitlockk review) — will the card actually PAINT this figure, or fall
 * through to its honest-empty glyph?
 *
 * The three withhold reasons above are not the only way the headline dashes.
 * `CostMetricCard` routes every value through `formatCurrencyTileValue`, which
 * emits `—` for anything nullish or non-finite — so a payload with real money in
 * a SIBLING field but a `null`/`NaN` in the `totalEstimatedCost` every mode
 * headlines renders a dash while every reason flag is false. The wire
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
 * states. While hydrating, the truthful wait caption (import vs plain loading,
 * from the caller); on a failed local read, no caption (the value dashes).
 *
 * ISS-4773 (whitlockk review): the LOCAL-fallback path composes rather than
 * replaces. Provenance and disclosure answer different questions ("where is this
 * number from" vs "why is there no number"), so both are stated.
 */
export function resolveCostCardDetail({
  loading,
  loadingDetail,
  localFallbackDetail,
  errored,
  showingLocalFallback,
  unpriceable,
}: {
  loading: boolean;
  loadingDetail: string;
  localFallbackDetail: string;
  errored: boolean;
  showingLocalFallback: boolean;
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
  // ISS-4748 / ISS-9969 retired the subscription-share clause this slot used to
  // carry ("+$X if billed to API"): the headline is now the inclusive total, so
  // that figure sits INSIDE the number rather than beside it, and breakdown
  // states it as a lane. ISS-10636 kept the unpriceable reason when it retired
  // the gate — nothing else on the card says why the headline dashed, and a
  // blanket suppression would have taken ISS-5401's only signal with it.
  const caption = unpriceable
    ? SESSIONS_COST_NO_COST_RECORDED_DETAIL
    : undefined;
  if (!showingLocalFallback) {
    return caption;
  }
  return caption === undefined
    ? localFallbackDetail
    : `${localFallbackDetail} · ${caption}`;
}

/**
 * The Cost card's one retirable state: a settled, successful read over a cohort
 * that genuinely carried no cost.
 *
 * Deliberately NOT the union `dashed` describes — that also covers a failed
 * read, the reader's own Unknown-cost facet, and a malformed settled payload,
 * none of which is an absence to hide. Exported so the strip can ask the same
 * question the tile answers, instead of re-deriving it a second way.
 */
export function isSettledEmptyCost({
  cardsLoading,
  costUnknownActive,
  errored,
  usage,
}: {
  cardsLoading: boolean;
  costUnknownActive: boolean;
  errored: boolean;
  usage: AgentSessionUsageSummary | undefined;
}): boolean {
  return (
    !(cardsLoading || errored) &&
    isCohortCostUnpriceable(usage) &&
    !costUnknownActive
  );
}

/**
 * ONE basis, whatever the payload: the subscription-inclusive
 * `totalEstimatedCost`, read from the producer and never recomputed, under the
 * one explanation of it. `apiEstimatedCost` backs no headline here.
 *
 * Operator ruling 2026-09-17 (ISS-10597): *"It should say Total Estimated Cost
 * and that is what it should show."* That reverses ISS-4401's direction — the
 * Sessions card and the Dashboard KPI now report the same basis, so there is
 * nothing left to disambiguate and no narrower bucket to fall back to.
 * ISS-10636 retired the gate that used to pick between the two.
 *
 * The LABEL is ruling 7's alias, not the canonical phrase: at this strip's card
 * widths the canonical phrase plus its info trigger does not fit on one line, so
 * the trigger orphans onto a second and the row's derived reservation grows a
 * blank line on every sibling. The measurement that licenses it is registered in
 * `TOTAL_ESTIMATED_COST_COPY.shortLabel`. The card's TOOLTIP still carries the
 * canonical explanation, so the short word is never the only thing said.
 *
 * Breakdown keeps its lanes when the partition reconciles; otherwise the card
 * headlines the total alone (`Total` mode). An unpriceable cohort still dashes
 * downstream (`resolveCostTileSlots`), so a settled `$0` is never asserted here.
 */
export function resolveCostCardPresentation(
  usage: AgentSessionUsageSummary | undefined
): CostCardPresentation {
  return {
    mode: canReportCostBreakdown(usage)
      ? CostCardPresentationMode.Breakdown
      : CostCardPresentationMode.Total,
    cost: usage?.totalEstimatedCost,
    label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
    info: TOTAL_ESTIMATED_COST_COPY.info,
  };
}
