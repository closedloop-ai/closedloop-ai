import type { TurnItem } from "@repo/api/src/types/agent-session";
import type { MergedTraceItem } from "@repo/api/src/types/branch";

/**
 * Idle threshold for the cross-session merged trace: a gap this long or longer
 * between two consecutive stamped items synthesizes an `idle` marker.
 *
 * SSOT pair with `DEFAULT_IDLE_THRESHOLD_MS` in
 * `packages/app/branches/lib/branch-derivations.ts` — the renderer re-derives
 * idle spans from the same instants and must agree with this builder.
 */
export const MERGED_TRACE_IDLE_THRESHOLD_MS = 120_000; // 2 min

/** Parse a subagent cost label (e.g. "$0.42") into a number, else null. */
export function parseSubagentCostUsd(value: string | null): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Map a Sessions-detail `TurnItem` onto the contract `MergedTraceItem`, tagging
 * its `sessionId`. The detail projection (`projectAgentSessionTurnItems`) only
 * ever emits `prompt`/`say`/`tools`/`subagent`/`event`/`end` — the per-session
 * `sessionstart` and the gap `idle` markers are SYNTHESIZED by the merge below
 * (the projection carries neither), so those fall through to `null` here.
 */
export function mapTurnItemToTrace(
  item: TurnItem,
  sessionId: string
): MergedTraceItem | null {
  switch (item.type) {
    case "prompt":
    case "say":
      return {
        type: item.type,
        sessionId,
        t: item.t,
        tMs: item.tMs,
        cumCostUsd: item.cum,
        actorName: item.actor.name,
        text: item.text,
      };
    case "tools":
      return {
        type: "tools",
        sessionId,
        t: item.t,
        tMs: item.tMs,
        endMs: item.endMs,
        summary: item.summary,
        hasFail: item.hasFail,
        failN: item.failN,
        // Carry the per-tool rows so the branch trace's tool cards expand with
        // the same detail the session-detail trace shows.
        items: item.items,
      };
    case "subagent":
      return {
        type: "subagent",
        sessionId,
        t: item.t,
        tMs: item.tMs,
        sub: item.sub,
        model: item.model,
        costUsd: parseSubagentCostUsd(item.cost),
      };
    case "event":
      return {
        type: "event",
        sessionId,
        t: item.t,
        dot: item.dot,
        text: item.text,
        tag: item.tag,
      };
    case "end":
      return { type: "end", sessionId, text: item.text };
    default:
      return null;
  }
}

/**
 * One branch-linked session's contribution to the merged trace: its identity, a
 * session-start actor, and its already-projected turn items. Callers project the
 * raw `AgentSessionEvent`s into `turnItems` on their own surface (the desktop
 * local loader or the cloud read path), then hand the surface-agnostic result
 * here so the map/merge/idle logic stays a single source of truth.
 */
export type MergedTraceSessionInput = {
  sessionId: string;
  /** ISO session start — anchors the synthesized `sessionstart` marker. */
  startedAt: string;
  /** `sessionstart.actor.name` (session name, else primary model). */
  actorName: string | null;
  /** `sessionstart.actor.harness`. */
  harness: string | null;
  turnItems: readonly TurnItem[];
};

/** Project one session's inputs into its stamped `MergedTraceItem`s (+ end tail). */
function collectSessionTraceItems(session: MergedTraceSessionInput): {
  stamped: { ms: number; item: MergedTraceItem }[];
  tail: MergedTraceItem[];
} {
  const stamped: { ms: number; item: MergedTraceItem }[] = [];
  const tail: MergedTraceItem[] = [];

  // Synthesize exactly one session-boundary marker at the session's start. The
  // detail projection never emits one, and the richer `isResumed`/`machine`
  // signals have no v1 producer — they stay undefined until a producer captures
  // them (the contract union already carries the optional fields).
  const startMs = Date.parse(session.startedAt);
  if (!Number.isNaN(startMs)) {
    stamped.push({
      ms: startMs,
      item: {
        type: "sessionstart",
        sessionId: session.sessionId,
        t: session.startedAt,
        actor: { name: session.actorName, harness: session.harness },
      },
    });
  }

  for (const turn of session.turnItems) {
    const mapped = mapTurnItemToTrace(turn, session.sessionId);
    if (!mapped) {
      continue;
    }
    if (mapped.type === "end") {
      tail.push(mapped);
      continue;
    }
    const ms = Date.parse(mapped.t);
    if (Number.isNaN(ms)) {
      continue;
    }
    stamped.push({ ms, item: mapped });
  }
  return { stamped, tail };
}

/**
 * Build the chronological cross-session `mergedTrace`: collect each session's
 * synthesized `sessionstart` + mapped turn items, k-way merge-sort all stamped
 * items by timestamp (flatten + stable sort by ms), and synthesize an `idle`
 * marker wherever consecutive items gap by >= the idle threshold. `end` markers
 * (which carry no timestamp) trail the stream.
 */
export function buildMergedTrace(
  sessions: readonly MergedTraceSessionInput[]
): MergedTraceItem[] {
  const stamped: { ms: number; item: MergedTraceItem }[] = [];
  const tail: MergedTraceItem[] = [];
  for (const session of sessions) {
    const collected = collectSessionTraceItems(session);
    stamped.push(...collected.stamped);
    tail.push(...collected.tail);
  }
  stamped.sort((a, b) => a.ms - b.ms);

  const merged: MergedTraceItem[] = [];
  for (let i = 0; i < stamped.length; i += 1) {
    const current = stamped[i];
    if (i > 0) {
      const previous = stamped[i - 1];
      const gapMs = current.ms - previous.ms;
      if (gapMs >= MERGED_TRACE_IDLE_THRESHOLD_MS) {
        merged.push({
          type: "idle",
          sessionId: current.item.sessionId,
          t: new Date(previous.ms).toISOString(),
          gapMs,
        });
      }
    }
    merged.push(current.item);
  }
  merged.push(...tail);
  return merged;
}
