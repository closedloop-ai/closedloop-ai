import type { TurnActor } from "@repo/api/src/types/agent-session";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import type { SessionTraceItem } from "@repo/app/agents/components/detail/session-trace";
import { formatTraceCostForDisplay } from "@repo/lib/sessions/trace-cost-format";
import {
  type BranchActorColorDomain,
  BranchActorTurnSide,
  buildActorColorDomain,
} from "./branch-actor-domain";

/**
 * Adapt the branch's lean `MergedTraceItem[]` to the agents `SessionTrace`'s
 * `SessionTraceItem` (`TurnItem`) shape, so the branch merged trace REUSES the
 * shared, design-matching trace renderer instead of a bespoke one. Each item's
 * `_row` is set to its index in the source array — the identity the E2 playhead
 * controller addresses rows by — so trace highlight/scroll stays in sync. Fields
 * the contract trace doesn't carry (per-tool detail, subagent body, tool cats)
 * map to empty defaults; `SessionTrace` then renders the summary rows without the
 * deep expansions, which D1 doesn't capture in v1.
 */

/** Distinct actors named anywhere in a merged trace for one shared Branch color domain. */
export function deriveActorsFromMergedTrace(
  items: readonly MergedTraceItem[]
): (string | null)[] {
  const out: (string | null)[] = [];
  for (const item of items) {
    if (item.type === "sessionstart") {
      out.push(item.actor.name);
    } else if (item.type === "prompt" || item.type === "say") {
      out.push(item.actorName);
    }
  }
  return out;
}

export function mergedTraceToSessionTraceItems(
  items: readonly MergedTraceItem[],
  domain?: BranchActorColorDomain
): SessionTraceItem[] {
  const colorDomain =
    domain ?? buildActorColorDomain(deriveActorsFromMergedTrace(items));
  const nameBySession = new Map<string, string | null>();
  const harnessBySession = new Map<string, string | null>();
  for (const item of items) {
    if (item.type === "sessionstart") {
      nameBySession.set(item.sessionId, item.actor.name);
      harnessBySession.set(item.sessionId, item.actor.harness);
    }
  }

  const actorFor = (
    sessionId: string,
    name: string | null,
    isHuman: boolean
  ): TurnActor => {
    const resolved = name ?? nameBySession.get(sessionId) ?? null;
    return {
      name: resolved,
      sessionId,
      human: isHuman ? resolved : null,
      color: colorDomain.colorForTurn(
        resolved,
        isHuman ? BranchActorTurnSide.Human : BranchActorTurnSide.Agent
      ),
      harness: harnessBySession.get(sessionId) ?? null,
    };
  };

  return items.map((item, row): SessionTraceItem => {
    switch (item.type) {
      case "sessionstart":
        return {
          type: "sessionstart",
          t: item.t,
          actor: actorFor(item.sessionId, item.actor.name, false),
        };
      case "idle":
        return { type: "idle", gap: item.gapMs };
      case "prompt":
        return {
          type: "prompt",
          _row: row,
          t: item.t,
          tMs: item.tMs,
          cum: item.cumCostUsd ?? 0,
          actor: actorFor(item.sessionId, item.actorName, true),
          text: item.text,
        };
      case "say":
        return {
          type: "say",
          _row: row,
          t: item.t,
          tMs: item.tMs,
          cum: item.cumCostUsd ?? 0,
          actor: actorFor(item.sessionId, item.actorName, false),
          text: item.text,
        };
      case "tools":
        return {
          type: "tools",
          _row: row,
          t: item.t,
          tMs: item.tMs,
          endMs: item.endMs,
          cum: 0,
          actor: actorFor(item.sessionId, null, false),
          summary: item.summary,
          // Carry the per-tool rows when the producer supplies them so the card
          // expands; older traces without detail degrade to an empty list.
          items: item.items ? [...item.items] : [],
          hasFail: item.hasFail,
          failN: item.failN,
          cats: {},
        };
      case "subagent":
        return {
          type: "subagent",
          _row: row,
          t: item.t,
          tMs: item.tMs,
          // FEA-4178: prefer the EXACT running cumulative the producer carried
          // (`cumCostUsd`); fall back to the rounded `costUsd` label parse only
          // for older producers that omit it.
          cum: item.cumCostUsd ?? item.costUsd ?? 0,
          actor: actorFor(item.sessionId, null, false),
          sub: item.sub,
          subagentType: null,
          status: "",
          model: item.model,
          duration: null,
          // FEA-4178: carry the sub-agent's own cost onto the collapsed box's
          // `duration · cost` meta row at parity with the single-session trace.
          // The branch merge preserves only the sub-agent cost (the lean
          // `MergedTraceItem` has no duration or token counts), so `duration`
          // and `tokens` stay null and the box drops those parts. There is no
          // per-sub-agent token source anywhere, so `tokens` is null on both
          // surfaces — do not describe the row as showing tokens. Prefer the
          // EXACT `costDeltaUsd` the producer carried; fall back to the rounded
          // `costUsd` label parse for older producers. `formatTraceCostForDisplay`
          // renders a sub-cent cost precisely (not floored to "$0.00") so a real
          // negligible slice stays distinct from the "no data" null.
          tokens: null,
          cost: formatTraceCostForDisplay(item.costDeltaUsd ?? item.costUsd),
          body: [],
        };
      case "event": {
        const tMs = Date.parse(item.t);
        return {
          type: "event",
          _row: row,
          t: item.t,
          tMs: Number.isNaN(tMs) ? 0 : tMs,
          dot: item.dot,
          text: item.text,
          tag: item.tag,
        };
      }
      default:
        return { type: "end", text: item.text };
    }
  });
}
