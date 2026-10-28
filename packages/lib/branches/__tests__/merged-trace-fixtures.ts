import type { TurnActor, TurnItem } from "@repo/api/src/types/agent-session";
import type { ToolItem } from "@repo/api/src/types/agent-session-tool-call";
import type { MergedTraceSessionInput } from "../merged-trace";

/**
 * Shared `buildMergedTrace` inputs for the merged-trace suites.
 *
 * Extracted (ISS-8767) when the corrupt-extent cases needed the same five
 * builders the idle-gap cases already had: a second copy would have been a
 * fixture that drifts from the one it is meant to mirror, and the two suites
 * assert about the SAME walk.
 */

/** A UTC instant `secondsFromEpochBase` after the suites' fixed base date. */
export const iso = (secondsFromEpochBase: number): string =>
  new Date(Date.UTC(2026, 6, 3, 0, 0, secondsFromEpochBase)).toISOString();

export function actor(sessionId: string): TurnActor {
  return { name: "Ada", sessionId, human: "Ada", color: "#64748B" };
}

export const toolItem: ToolItem = { label: "bash", detail: "ls", err: false };

export function session(
  overrides: Partial<MergedTraceSessionInput> & { sessionId: string }
): MergedTraceSessionInput {
  return {
    startedAt: iso(0),
    actorName: "Ada",
    harness: "claude",
    turnItems: [],
    ...overrides,
  };
}

/**
 * `endMs` is deliberately an unconstrained `number` rather than a helper that
 * derives it: every corrupt-extent case exists precisely because the wire
 * contract lets a producer put any number here.
 */
export function toolsTurn(args: {
  atSeconds: number;
  endMs: number;
}): TurnItem {
  return {
    type: "tools",
    _row: 0,
    t: iso(args.atSeconds),
    tMs: Date.parse(iso(args.atSeconds)),
    endMs: args.endMs,
    cum: 0,
    actor: actor("a"),
    summary: "1 tool",
    items: [toolItem],
    hasFail: false,
    failN: 0,
    cats: { bash: 1 },
  };
}

export function promptTurn(atSeconds: number): TurnItem {
  return {
    type: "prompt",
    _row: 1,
    t: iso(atSeconds),
    tMs: Date.parse(iso(atSeconds)),
    cum: 0,
    actor: actor("a"),
    text: `prompt at ${atSeconds}`,
  };
}

export function sayTurn(atSeconds: number): TurnItem {
  return {
    type: "say",
    _row: 2,
    t: iso(atSeconds),
    tMs: Date.parse(iso(atSeconds)),
    cum: 0,
    actor: actor("a"),
    text: `say at ${atSeconds}`,
  };
}
