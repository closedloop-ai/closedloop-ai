import {
  hasPositiveCost,
  isSubstantiveSession,
} from "@repo/api/src/agent-session-filters";
import { isSubscriptionBillingMode } from "@repo/api/src/types/billing-mode";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import { MAX_SESSION_ESTIMATED_COST_USD } from "@repo/cost/session-web-search-cost";

export const CostAvailability = {
  Available: "available",
  Subscription: "subscription",
  Unavailable: "unavailable",
  NoTokenUsage: "no_token_usage",
  NoUsage: "no_usage",
} as const;

export type CostAvailability =
  (typeof CostAvailability)[keyof typeof CostAvailability];

export function deriveCostAvailability(session: {
  estimatedCost: number | null;
  billingMode?: string | null;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
  componentInvocationCount?: number;
  model?: string | null;
}): CostAvailability {
  // ISS-4418: a session that never did measurable work (no turns, no tokens, no
  // tool uses, no positive cost) renders `—` for EVERY billing mode. The
  // decision keys on evidence of real work, not on billing mode: subscription
  // mode alone must not manufacture a `$0.00` that asserts a measured true-zero
  // the session never earned. A `—` unknown-billing zero-usage session and a
  // `$0.00` subscription zero-usage session on the same screen were two truths
  // for one empty state; both now read `—`.
  if (!sessionDidMeasurableWork(session)) {
    return CostAvailability.NoUsage;
  }
  // A subscription session that DID run keeps its subscription treatment (its
  // spend is covered, so we show the covered cost / subscription tooltip).
  if (isSubscriptionBillingMode(session.billingMode)) {
    return CostAvailability.Subscription;
  }
  if (hasPositiveCost(session.estimatedCost)) {
    return CostAvailability.Available;
  }
  // ISS-5572: `Unavailable` was defined around the unpriced-MODEL case and then
  // became the catch-all terminal branch, so it did double duty for "this model
  // isn't priced" and "there was no usage to price". Those are different causes
  // and its tooltip names only the first one. A session that registered a turn
  // or a tool use but consumed ZERO tokens (the errored-on-turn-one shape:
  // `turns: 1`, every token counter 0, and frequently `model: null`, so "this
  // model" refers to nothing) has nothing to price at all — pricing config is
  // not the reason its Cost is a dash. Split it out so the explanation points at
  // the session instead of sending the reader to check model pricing. The dash
  // itself is unchanged: this stays a non-Available/non-Subscription branch, the
  // exact predicate `formatCostLabel` keys on.
  if (!hasRecordedTokenUsage(session)) {
    return CostAvailability.NoTokenUsage;
  }
  // Consumed real tokens but no priced cost — pricing is genuinely unavailable
  // for this model, distinct from a session that never ran and from one that
  // ran without recording usage.
  return CostAvailability.Unavailable;
}

export function formatCostLabel(
  availability: CostAvailability,
  estimatedCost: number | null
): string {
  return costLabelIsFigure(availability)
    ? formatCost(estimatedCost ?? undefined)
    : "—";
}

/**
 * Whether an availability's Cost label is a real FIGURE rather than a dash.
 *
 * `Subscription` is in the set, and that is the whole reason this is a named
 * predicate: covered spend still prints its dollars, so "subscription" reads
 * like a word-rendering state and is not one. Three callers had already
 * re-derived the distinction — the Session Timeline strip's `costUnavailable`,
 * ISS-7737's Cost population sentence, which first got it WRONG by keying on
 * `Available` alone and silently withheld itself from every subscription-billed
 * session, and ISS-7427's Cost provenance sentence, which arrived as a second
 * extraction of this same predicate (`isCostFigureRendered`) and was folded in
 * here on merge rather than kept beside it. {@link formatCostLabel} now answers
 * from here too, so the formatter and its readers cannot disagree about what
 * counts as a dash, and a new `CostAvailability` member has one obvious place to
 * be classified — the exhaustive `Record` below, which fails typecheck until it
 * is.
 */
export function costLabelIsFigure(availability: CostAvailability): boolean {
  return COST_LABEL_IS_FIGURE[availability];
}

export function getCostTooltip(availability: CostAvailability): string | null {
  return COST_TOOLTIP[availability];
}

/**
 * ISS-4418: did the session do measurable work? True when there is any evidence
 * the session actually ran. Delegates to the canonical `isSubstantiveSession`
 * SSOT (`@repo/api/src/agent-session-filters`) — the SAME predicate that badges
 * a row Idle vs substantive on every surface (its SQL twin
 * `SESSION_SUBSTANTIVE_WHERE` and its desktop twin) — so Cost can never disagree
 * with the Idle badge for the same row: at least one turn, OR any consumed token
 * (input + output + cache read + cache write), OR at least one tool use, OR at
 * least one component invocation (ISS-5801 — an invocation-only session did run,
 * so it lands on `NoTokenUsage`, never on `NoUsage`'s idle dash).
 *
 * Model metadata is deliberately NOT a work signal: the Claude parser persists a
 * `/model`-switch display fallback for a model-switch-only transcript with no
 * assistant turns or token usage (see `data-revision.ts`), so a non-blank
 * `model` on a zero-turn/zero-token/zero-tool session proves nothing ran. The
 * only cost-specific override is a positive priced cost (checked here first) —
 * if we spent real money, we did real work regardless of the counters.
 *
 * Every signal is optional + coalesced by the shared predicate, so a
 * version-skewed producer that omits a field degrades safely (a missing field
 * contributes no evidence, never a crash).
 */
function sessionDidMeasurableWork(session: {
  estimatedCost: number | null;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
  componentInvocationCount?: number;
}): boolean {
  if (hasPositiveCost(session.estimatedCost)) {
    return true;
  }
  return isSubstantiveSession({
    turns: session.turns,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheReadTokens: session.cacheReadTokens,
    cacheWriteTokens: session.cacheWriteTokens,
    toolUseCount: session.toolUseCount,
    componentInvocationCount: session.componentInvocationCount,
  });
}

/**
 * ISS-4418 convenience: the Cost display string for a session, derived through
 * the SAME `deriveCostAvailability` + `formatCostLabel` path the Sessions table
 * and the detail Cost metric use, so the session-detail Properties row can never
 * fall back to a raw pre-formatted `session.cost` (a fabricated `$0.00`/`$4.82`)
 * that contradicts the metric card for a zero-usage session.
 */
export function deriveSessionCostLabel(session: {
  estimatedCost: number | null;
  billingMode?: string | null;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
  componentInvocationCount?: number;
  model?: string | null;
}): string {
  return formatCostLabel(
    deriveCostAvailability(session),
    session.estimatedCost
  );
}

/**
 * ISS-5572: the canonical Cost tooltip per availability, as an exhaustive
 * `Record` rather than a `switch` with a `default`. Every surface that explains
 * a Cost dash reads this one map, and a member added to `CostAvailability`
 * fails `tsc` here until someone decides what it should SAY — the previous
 * `default: null` silently gave a new state no explanation at all, which is how
 * a dash ends up unexplained or, worse, explained by the wrong neighbouring
 * case. `null` is a deliberate entry, not an omission: `Available` needs no
 * explanation because it renders a real figure, and `NoUsage` is already
 * self-evident from an Idle row.
 */
const COST_TOOLTIP: Record<CostAvailability, string | null> = {
  [CostAvailability.Available]: null,
  [CostAvailability.Subscription]: "Billed through your subscription",
  [CostAvailability.Unavailable]: "No pricing data for this model",
  [CostAvailability.NoTokenUsage]: "No token usage recorded to price",
  [CostAvailability.NoUsage]: null,
};

/**
 * ISS-5572: every token counter the session could have consumed, summed. Zero
 * here means there is literally nothing to price, whatever the turn/tool
 * counters say.
 *
 * EVERY counter is coalesced, including the two the type declares as required.
 * Code review: the earlier version added those two raw on the reasoning that
 * "a `?? 0` on a field the type guarantees is a branch that can never be
 * taken" — but the guarantee is a compile-time one and these values arrive
 * across a JSON boundary. The detail path hands this the raw API record
 * (`deriveSessionCostLabel` in `agent-session-detail-view.tsx`,
 * `deriveCostAvailability` in `detail-content.ts`), unlike the list, which
 * reads it through {@link deriveReportedCost} first (`session-table-row.ts`).
 * A version-skewed producer that omits `inputTokens` therefore yields
 * `undefined + number` → `NaN`, and `NaN === 0` is false, so the
 * `NoTokenUsage` branch above became UNREACHABLE on exactly the payload it was
 * written for: the session lands on `Unavailable` and its tooltip blames model
 * pricing config for a record that reported no usage at all — the precise
 * confusion ISS-5572 split these two states apart to end.
 *
 * `sessionDidMeasurableWork` never had this hole because it delegates to
 * `isSubstantiveSession`, which coalesces all four. Matching it here makes the
 * two predicates agree on a skewed payload instead of diverging on one.
 */
function getConsumedTokenTotal(session: TokenCounters): number {
  return (
    (session.inputTokens ?? 0) +
    (session.outputTokens ?? 0) +
    (session.cacheReadTokens ?? 0) +
    (session.cacheWriteTokens ?? 0)
  );
}

/**
 * The four token counters a session can report, every one optional and
 * nullable because they cross a JSON boundary — see {@link getConsumedTokenTotal}
 * for why coalescing the two the wire type declares as required is load-bearing
 * rather than defensive.
 */
type TokenCounters = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
};

/**
 * ISS-5637: did this session record any token usage AT ALL?
 *
 * The one piece of evidence that separates a session whose usage was never
 * recorded from one measured at zero, exported so the session-detail Tokens row
 * asks the SAME question the Cost row above already asks. It was previously
 * inlined as the `=== 0` test in {@link deriveCostAvailability}, so the Tokens
 * row had to invent its own answer — and invented a WRONG one, keying its
 * unknown state on a per-counter `null` that neither producer can emit (the
 * cloud reads four `BigInt @default(0)` columns through a `toNumber` that maps
 * null to `0`; the desktop folds `sumTokenUsage` out of `zeroTotals()`). A
 * zero-usage session therefore asserted `0 in | 0 out | 0 cache read | 0 cache
 * write` two rows above a Cost dash meaning "no token usage recorded to price".
 * One predicate, one owner, so the two rows cannot state opposite things about
 * one session again.
 *
 * SUMMED, never per counter. A zero `cacheReadTokens` inside a session that
 * consumed real input tokens is a MEASURED zero and must keep rendering as one;
 * only a session whose whole quadruple is zero has no usage evidence to report.
 */
export function hasRecordedTokenUsage(counters: TokenCounters): boolean {
  return getConsumedTokenTotal(counters) > 0;
}

/**
 * Which availabilities render the Cost label as a figure rather than a dash —
 * the decision {@link formatCostLabel} makes and {@link costLabelIsFigure} is
 * how callers ask. Moved here from `session-timeline-summary.tsx` (ISS-7737) so
 * it sits with the formatter it describes instead of beside one of its readers.
 *
 * An exhaustive `Record`, like {@link COST_TOOLTIP}, and not a `Set` of the two
 * true cases: this is now the shared authority behind every Cost render, so a
 * new `CostAvailability` must DECLARE whether it shows money. A membership set
 * would let the next state default to a silent dash, which is exactly the
 * "unknown quietly renders as a real answer" failure this module exists to stop.
 */
const COST_LABEL_IS_FIGURE: Record<CostAvailability, boolean> = {
  [CostAvailability.Available]: true,
  [CostAvailability.Subscription]: true,
  [CostAvailability.Unavailable]: false,
  [CostAvailability.NoTokenUsage]: false,
  [CostAvailability.NoUsage]: false,
};

/**
 * ISS-9431: the Cost a Sessions row may state from inputs that crossed a JSON
 * wire (web) or structured-clone IPC (Desktop), where the declared `number`s are
 * not a runtime guarantee — or `null` when an input the row cannot vouch for
 * decides it.
 *
 * An ABSENT input reads as `0`: a version-skewed producer that omits one
 * contributes no evidence. A PRESENT `estimatedCost` that is not a finite,
 * non-negative number the cost column can store (at most
 * `MAX_SESSION_ESTIMATED_COST_USD`) is refused outright, because it is the
 * figure itself. A
 * PRESENT counter that is not a non-negative safe integer is refused only when
 * the answer turns on it, so a corrupt `toolUseCount` cannot blank a price
 * {@link deriveCostAvailability} decides from `estimatedCost` alone, and cannot
 * invent a `$0.00` for a row whose only work evidence it is.
 *
 * That derivation reads every counter through a `> 0` test and nothing else, so
 * deriving once with each unusable counter at `0` and once at `1` covers every
 * value it could have held: agreement is an answer, disagreement would be a
 * guess. A counter read any other way breaks that, and must be handled here.
 */
export function deriveReportedCost(
  reported: ReportedCostInputs
): ReportedCost | null {
  const estimatedCost = readReportedAmount(reported.estimatedCost);
  if (estimatedCost === null) {
    return null;
  }
  const deriveWithUnusableCountersAs = (probe: number) =>
    deriveCostAvailability({
      ...readReportedCounters(reported, probe),
      billingMode: reported.billingMode,
      estimatedCost,
      model: reported.model,
    });
  const availability = deriveWithUnusableCountersAs(0);
  return availability === deriveWithUnusableCountersAs(1)
    ? { availability, estimatedCost }
    : null;
}

/** The Cost inputs as a list item reports them; see {@link deriveReportedCost}. */
type ReportedCostInputs = Readonly<{
  estimatedCost?: unknown;
  billingMode?: string | null;
  model?: string | null;
  turns?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  toolUseCount?: unknown;
  componentInvocationCount?: unknown;
}>;

type ReportedCost = Readonly<{
  availability: CostAvailability;
  /** The figure a `Subscription` or `Available` label prints. */
  estimatedCost: number;
}>;

function readReportedCounters(
  reported: ReportedCostInputs,
  unusableAs: number
) {
  const read = (value: unknown) => readReportedCount(value) ?? unusableAs;
  return {
    turns: read(reported.turns),
    inputTokens: read(reported.inputTokens),
    outputTokens: read(reported.outputTokens),
    cacheReadTokens: read(reported.cacheReadTokens),
    cacheWriteTokens: read(reported.cacheWriteTokens),
    toolUseCount: read(reported.toolUseCount),
    componentInvocationCount: read(reported.componentInvocationCount),
  };
}

/**
 * A dollar amount: absent as `0`; finite, non-negative and storable as itself;
 * else `null`. `SessionDetail.estimatedCost` is `Decimal(14, 6)`, so a larger
 * figure from a version-skewed producer is not one the platform could hold.
 */
function readReportedAmount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SESSION_ESTIMATED_COST_USD
    ? value
    : null;
}

/** A count: absent as `0`, a non-negative safe integer as itself, else `null`. */
function readReportedCount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * ISS-7229: Claude's own reported cost, or `null` when Claude reported nothing.
 * `0` is a REPORTED value, so this is an explicit null/finite test rather than
 * a truthiness check that would erase it. `SessionCostValue` prints the figure
 * and the Session Details host decides whether its Cost row is drawn from this
 * same read, so the row cannot be left out while the cell has a figure to show.
 */
export function claudeReportedCost(
  session: Readonly<{ authoritativeCostUsd?: number | null }>
): number | null {
  const reported = session.authoritativeCostUsd;
  return reported !== null &&
    reported !== undefined &&
    Number.isFinite(reported)
    ? reported
    : null;
}
