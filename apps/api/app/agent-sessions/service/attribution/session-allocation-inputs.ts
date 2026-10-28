/**
 * ISS-12552: the priced half of the session allocation: a
 * pricer from the pricing engine's model and category rates, and the stored
 * session total. Units, recipients and operations are built by
 * `@repo/lib/attribution/allocation-inputs`.
 */
import { UsageTokenCategory } from "@repo/api/src/types/attribution-evidence";
import { computeTokenCost, type TokenCostResult } from "@repo/cost/genai-cost";
import type { Prisma } from "@repo/database";
import type { AllocationPricer } from "@repo/lib/allocation/price-allocation";
import {
  ALLOCATION_CATEGORY_COUNTS,
  type AllocationUsageEvent,
} from "@repo/lib/attribution/allocation-inputs";

export type AllocationTokenEvent = AllocationUsageEvent & {
  estimatedCost: Prisma.Decimal | null;
};

const CATEGORY_COST: Record<UsageTokenCategory, keyof TokenCostResult> = {
  [UsageTokenCategory.Input]: "inputCostUsd",
  [UsageTokenCategory.Output]: "outputCostUsd",
  [UsageTokenCategory.CacheRead]: "cacheReadCostUsd",
  [UsageTokenCategory.CacheWrite]: "cacheWriteCostUsd",
};

export const MICROS_PER_USD = 1_000_000;
const UNPRICED_PRICE_KEY_SUFFIX = " (unpriced)";

/**
 * Prices each (model, category) from the session's own stored per-event costs
 * (PRD-800; Daveth Oakhurst, 2026-10-20: allocation conserves the
 * per-event cost, never the session's stored total). Each priced event's
 * stored cost is split across its token categories in the proportions the
 * pricing engine gives that event at its own time, so each provider's
 * input-token convention and per-request price tier hold. An event with no
 * stored cost carries tokens and no cost: its tokens are allocated, its cost is
 * not, and they are counted by {@link unpricedTokens}. Its units carry a price
 * key of their own ({@link allocationPriceKey}) priced at 0, so its tokens
 * never enter a priced rate (PRD-800 'Unpriced usage': cost is
 * allocated only for priced events). A negative stored cost is an impossible
 * price, which the kernel reports.
 */
export function categoryPricer(
  events: readonly AllocationTokenEvent[]
): AllocationPricer {
  const sums = new Map<string, { tokens: number; usd: number }>();
  const unpricedKeys = new Set<string>();
  const uniform = uniformRates(events);
  for (const event of events) {
    if (event.estimatedCost === null) {
      unpricedKeys.add(allocationPriceKey(event));
      continue;
    }
    const split = categoryCostSplit(event, event.estimatedCost);
    for (const [category, field] of ALLOCATION_CATEGORY_COUNTS) {
      const tokens = Number(event[field]);
      if (tokens === 0) {
        continue;
      }
      const key = rateKey(event.model, category);
      const sum = sums.get(key) ?? { tokens: 0, usd: 0 };
      sum.tokens += tokens;
      sum.usd +=
        split === undefined
          ? tokens * (uniform.get(event.model) ?? 0)
          : (split.get(category) ?? 0);
      sums.set(key, sum);
    }
  }
  return ({ priceKey, category, tokens }) => {
    if (tokens === 0 || unpricedKeys.has(priceKey)) {
      return 0;
    }
    const sum = sums.get(rateKey(priceKey, category));
    return sum ? (tokens * sum.usd * MICROS_PER_USD) / sum.tokens : Number.NaN;
  };
}

/**
 * One priced event's stored cost by category, undefined when the engine cannot
 * price its model. That case is a per-model
 * uniform rate ({@link uniformRates}), used only there: the event's stored cost
 * is conserved and the engine stays the price authority for every model it can
 * price (PRD-800 'Unpriced usage'; Daveth Oakhurst, 2026-10-20).
 */
function categoryCostSplit(
  event: AllocationTokenEvent,
  estimatedCost: Prisma.Decimal
): Map<UsageTokenCategory, number> | undefined {
  const cost = engineCost(event);
  if (!cost.priced) {
    return undefined;
  }
  const split = new Map<UsageTokenCategory, number>();
  const stored = estimatedCost.toNumber();
  const weights = ALLOCATION_CATEGORY_COUNTS.map(
    ([category]): [UsageTokenCategory, number] => [
      category,
      Number(cost[CATEGORY_COST[category]]),
    ]
  );
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [category, weight] of weights) {
    split.set(category, total > 0 ? (stored * weight) / total : 0);
  }
  return split;
}

function rateKey(model: string, category: string): string {
  return `${model}\u0000${category}`;
}

/**
 * The session's priced cost in micro-dollars: the sum of its events' stored
 * costs. Null, never 0, when no event has one.
 */
export function sessionTotalMicros(
  events: readonly AllocationTokenEvent[]
): number | null {
  let micros: number | null = null;
  for (const event of events) {
    if (event.estimatedCost !== null) {
      micros =
        (micros ?? 0) +
        Number(event.estimatedCost.mul(MICROS_PER_USD).toFixed(0));
    }
  }
  return micros;
}

/** Tokens of events with no stored cost: allocated, never priced. */
export function unpricedTokens(
  events: readonly AllocationTokenEvent[]
): number {
  return events
    .filter((event) => event.estimatedCost === null)
    .reduce((sum, event) => sum + eventTokens(event), 0);
}

/**
 * Usage the pricer prices at a per-model uniform rate: events with a stored
 * cost whose model the engine cannot price per category. Reported as coverage,
 * never a contract field.
 */
export function uniformRateUsage(events: readonly AllocationTokenEvent[]): {
  tokens: number;
  micros: number;
} {
  let tokens = 0;
  let micros = 0;
  for (const event of events) {
    if (event.estimatedCost === null || engineCost(event).priced) {
      continue;
    }
    tokens += eventTokens(event);
    micros += Number(event.estimatedCost.mul(MICROS_PER_USD).toFixed(0));
  }
  return { tokens, micros };
}

/** USD per token for each model the engine cannot price, from stored costs. */
function uniformRates(
  events: readonly AllocationTokenEvent[]
): Map<string, number> {
  const totals = new Map<string, { tokens: number; usd: number }>();
  for (const event of events) {
    if (event.estimatedCost === null || engineCost(event).priced) {
      continue;
    }
    const total = totals.get(event.model) ?? { tokens: 0, usd: 0 };
    total.tokens += eventTokens(event);
    total.usd += event.estimatedCost.toNumber();
    totals.set(event.model, total);
  }
  return new Map(
    [...totals].map(([model, { tokens, usd }]) => [
      model,
      tokens > 0 ? usd / tokens : 0,
    ])
  );
}

function engineCost(event: AllocationTokenEvent): TokenCostResult {
  return computeTokenCost({
    model: event.model,
    inputTokens: Number(event.inputTokens),
    outputTokens: Number(event.outputTokens),
    cacheReadTokens: Number(event.cacheReadTokens),
    cacheWriteTokens: Number(event.cacheWriteTokens),
    timestamp: event.eventCreatedAt,
  });
}

function eventTokens(event: AllocationTokenEvent): number {
  return ALLOCATION_CATEGORY_COUNTS.reduce(
    (sum, [, field]) => sum + Number(event[field]),
    0
  );
}

/**
 * The price key of an event's usage units: its model, or a key of its own when
 * it has no stored cost, so its tokens form their own bucket that
 * {@link categoryPricer} prices at 0.
 */
export function allocationPriceKey(event: AllocationTokenEvent): string {
  return event.estimatedCost === null
    ? `${event.model}${UNPRICED_PRICE_KEY_SUFFIX}`
    : event.model;
}
