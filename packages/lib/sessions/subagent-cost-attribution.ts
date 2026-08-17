import type {
  TokenEventCostPoint,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { formatTraceCostForDisplay } from "./trace-cost-format";

/**
 * FEA-4178: attribute per-event token-cost points onto the session-detail trace's
 * cost-bearing turn items, and derive each sub-agent's collapsed-box `cost` label.
 *
 * Two attribution axes, deliberately separate:
 *
 * 1. **`cum` / `costDelta` on every cost-bearing item** — the running per-turn
 *    spend the session-LEVEL trace renders. Attributed purely by TIMESTAMP
 *    (`findAttributionTarget`): each event's cost lands on the nearest preceding
 *    non-prompt item. This is the pre-existing behavior and is preserved verbatim
 *    so the session-level cost column does not shift.
 *
 * 2. **The sub-agent collapsed-box `cost` label** — a per-SUB-AGENT figure that
 *    must not over-report. Timestamp attribution alone mis-attributes here: when
 *    a sub-agent runs tools or spawns cost-bearing rows, later events attribute to
 *    those newer rows (under-reporting the sub-agent), and when two sub-agents
 *    overlap, a still-running A's event can land on B (over-reporting B). So the
 *    label is metered by OWNERSHIP when the events carry it, and OMITTED when
 *    ownerless events are ambiguous:
 *      - Events carrying `agentExternalId` are summed per owning agent; a
 *        sub-agent whose identity matches shows that exact owned sum.
 *      - A sub-agent with no owned events falls back to its timestamp `costDelta`
 *        ONLY when no other sub-agent's span overlaps it (unambiguous); when
 *        spans overlap and the events are ownerless, the label is left unset so
 *        the box hides a figure it cannot trust rather than lie.
 */

const COST_BEARING_TYPES = new Set(["prompt", "say", "tools", "subagent"]);

type CostBearingItem = Extract<
  TurnItem,
  { type: "prompt" | "say" | "tools" | "subagent" }
>;

type SubagentItem = Extract<TurnItem, { type: "subagent" }>;

/**
 * One sub-agent's identity + half-open `[startMs, endMs)` span, paired with the
 * trace item whose `cost` label this attribution sets. Built by the projection,
 * which is the only place both the raw agent rows and the projected items exist.
 */
export type SubagentCostSpan = {
  externalAgentId: string | null;
  startMs: number;
  endMs: number;
  item: SubagentItem;
};

export function isCostBearingItem(item: TurnItem): item is CostBearingItem {
  return COST_BEARING_TYPES.has(item.type);
}

function findAttributionTarget(
  costBearing: CostBearingItem[],
  eventTMs: number
): number {
  let targetIndex = -1;
  for (let i = costBearing.length - 1; i >= 0; i--) {
    if (costBearing[i].tMs <= eventTMs) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0 || costBearing[targetIndex].type === "prompt") {
    const searchFrom = Math.max(targetIndex, 0);
    for (let i = searchFrom; i < costBearing.length; i++) {
      if (costBearing[i].type !== "prompt") {
        return i;
      }
    }
    return 0;
  }
  return targetIndex;
}

/** True when `span` overlaps any OTHER sub-agent span (half-open intervals). */
function spanOverlapsAnother(
  span: SubagentCostSpan,
  spans: readonly SubagentCostSpan[]
): boolean {
  for (const other of spans) {
    if (other === span) {
      continue;
    }
    if (span.startMs < other.endMs && other.startMs < span.endMs) {
      return true;
    }
  }
  return false;
}

/**
 * Sum each event's cost onto its owning agent (`agentExternalId`). Ownerless
 * events are excluded — they carry no ownership signal and must not inflate any
 * agent's owned total.
 */
function ownedCostByAgent(
  tokenEvents: readonly TokenEventCostPoint[]
): Map<string, number> {
  const owned = new Map<string, number>();
  for (const event of tokenEvents) {
    const owner = event.agentExternalId;
    if (!owner) {
      continue;
    }
    const costUsd = event.costUsd ?? 0;
    if (costUsd === 0) {
      continue;
    }
    owned.set(owner, (owned.get(owner) ?? 0) + costUsd);
  }
  return owned;
}

/**
 * Set each sub-agent item's collapsed-box `cost` label per the ownership /
 * ambiguity policy documented at the top of this file. `costDelta` (already set
 * on the item by the timestamp pass) is the unambiguous-fallback source.
 */
function labelSubagentCosts(
  spans: readonly SubagentCostSpan[],
  ownedByAgent: Map<string, number>
): void {
  for (const span of spans) {
    const owner = span.externalAgentId;
    const ownedCost = owner == null ? undefined : ownedByAgent.get(owner);
    if (ownedCost !== undefined) {
      // Metered by ownership: this agent's own events, immune to overlap.
      span.item.cost = formatTraceCostForDisplay(ownedCost);
      continue;
    }
    // Ownerless events: the timestamp `costDelta` is only trustworthy when this
    // sub-agent's span stands alone. When another sub-agent overlaps, the delta
    // may be wearing that neighbor's spend, so omit the label.
    if (spanOverlapsAnother(span, spans)) {
      span.item.cost = null;
      continue;
    }
    // A zero delta is "no attributed spend" (absent), not "$0.00"; only a
    // nonzero fallback delta is rendered — precisely, so a sub-cent figure
    // survives instead of flooring to "$0.00" (wongk review).
    const delta = span.item.costDelta ?? 0;
    span.item.cost = delta > 0 ? formatTraceCostForDisplay(delta) : null;
  }
}

/**
 * Attribute token-event costs onto the projected turn items (mutates in place):
 * timestamp-derived `cum`/`costDelta` for the session-level column, then the
 * ownership/ambiguity-aware sub-agent `cost` labels.
 */
export function attributeTokenEventCosts(
  items: TurnItem[],
  tokenEvents: readonly TokenEventCostPoint[] | undefined,
  subagentSpans: readonly SubagentCostSpan[]
): void {
  const costBearing = items.filter(isCostBearingItem);
  if (costBearing.length === 0) {
    return;
  }

  if (!tokenEvents || tokenEvents.length === 0) {
    return;
  }

  const deltas = new Map<number, number>();
  const sortedEvents = [...tokenEvents].sort((a, b) => a.tMs - b.tMs);

  for (const event of sortedEvents) {
    if (!Number.isFinite(event.tMs)) {
      continue;
    }
    const costUsd = event.costUsd ?? 0;
    if (costUsd === 0) {
      continue;
    }

    const targetIndex = findAttributionTarget(costBearing, event.tMs);
    deltas.set(targetIndex, (deltas.get(targetIndex) ?? 0) + costUsd);
  }

  let cumulative = 0;
  for (let i = 0; i < costBearing.length; i++) {
    const item = costBearing[i];
    const delta = deltas.get(i) ?? 0;
    cumulative += delta;
    item.costDelta = delta;
    item.cum = cumulative;
  }

  labelSubagentCosts(subagentSpans, ownedCostByAgent(sortedEvents));
}
