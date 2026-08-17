import { isSubstantiveSession } from "@repo/api/src/agent-session-filters";
import { isSubscriptionBillingMode } from "@repo/api/src/types/billing-mode";
import { formatCost } from "@repo/app/shared/lib/format-utils";

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
  estimatedCost: number;
  billingMode?: string | null;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
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
  if (session.estimatedCost > 0) {
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
  // exact predicate `formatCostLabel` and the cost-authority mirrors key on.
  if (getConsumedTokenTotal(session) === 0) {
    return CostAvailability.NoTokenUsage;
  }
  // Consumed real tokens but no priced cost — pricing is genuinely unavailable
  // for this model, distinct from a session that never ran and from one that
  // ran without recording usage.
  return CostAvailability.Unavailable;
}

export function formatCostLabel(
  availability: CostAvailability,
  estimatedCost: number
): string {
  switch (availability) {
    case CostAvailability.Available:
    case CostAvailability.Subscription:
      return formatCost(estimatedCost);
    default:
      return "—";
  }
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
 * (input + output + cache read + cache write), OR at least one tool use.
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
  estimatedCost: number;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
}): boolean {
  if (session.estimatedCost > 0) {
    return true;
  }
  return isSubstantiveSession({
    turns: session.turns,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheReadTokens: session.cacheReadTokens,
    cacheWriteTokens: session.cacheWriteTokens,
    toolUseCount: session.toolUseCount,
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
  estimatedCost: number;
  billingMode?: string | null;
  turns?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUseCount?: number;
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
 * normalizes through `toSafeNumber` first (`session-table-row.ts`). A
 * version-skewed producer that omits `inputTokens` therefore yields
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
function getConsumedTokenTotal(session: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return (
    (session.inputTokens ?? 0) +
    (session.outputTokens ?? 0) +
    (session.cacheReadTokens ?? 0) +
    (session.cacheWriteTokens ?? 0)
  );
}
