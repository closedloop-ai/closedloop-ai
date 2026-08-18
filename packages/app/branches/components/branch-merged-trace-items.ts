import type { SessionTraceItem } from "@repo/app/agents/components/detail/session-trace";

type CostBearingTraceItem = Extract<
  SessionTraceItem,
  { type: "prompt" | "say" | "tools" | "subagent" }
>;

/**
 * Converts cumulative branch trace cost points into per-turn deltas.
 *
 * The shared trace accepts both cumulative and delta fields. Branches must show
 * only the delta in each turn gutter, so this removes the cumulative display
 * source after deriving a monotonic per-Session delta from it.
 */
export function withPerTurnTraceCosts(
  items: readonly SessionTraceItem[]
): SessionTraceItem[] {
  const previousCostBySession = new Map<string, number>();
  return items.map((item) => {
    if (!isCostBearingItem(item)) {
      return item;
    }
    const sessionId = item.actor.sessionId;
    const previous = previousCostBySession.get(sessionId) ?? 0;
    const cumulative = finitePositiveCost(item.cum);
    const costDelta =
      cumulative != null && cumulative >= previous
        ? cumulative - previous
        : item.costDelta;
    if (cumulative != null && cumulative >= previous) {
      previousCostBySession.set(sessionId, cumulative);
    }
    return {
      ...item,
      costDelta,
      cum: 0,
    };
  });
}

function isCostBearingItem(
  item: SessionTraceItem
): item is CostBearingTraceItem {
  return (
    item.type === "prompt" ||
    item.type === "say" ||
    item.type === "tools" ||
    item.type === "subagent"
  );
}

function finitePositiveCost(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}
