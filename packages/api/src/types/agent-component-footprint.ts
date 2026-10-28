/**
 * ISS-10736 — where each invocation kind's CONTEXT FOOTPRINT is counted from.
 *
 * PRD-753 R6 treats `footprintTokens` as the one denominator every kind holds,
 * which is what makes "net contribution to context" the first ratio available
 * even to the five kinds that declare no numerator. Measured 2026-09-19 against
 * the local desktop corpus, that denominator was empty on all 457,224
 * invocation rows: both Prisma schemas carry the column and both transports
 * carry the field, but NOTHING COMPUTED A VALUE. The diagnosis is "no producer"
 * — `AgentComponentInvocationCandidate` had no footprint member at all and the
 * row writer's explicit column list never named `footprint_tokens`.
 *
 * This module is the producer's contract: which text a kind's footprint is
 * counted from, and how the resulting number is labelled.
 *
 * EXHAUSTIVE BY CONSTRUCTION. {@link AGENT_COMPONENT_FOOTPRINT_SOURCE} is a
 * `Record<AgentComponentInvocationKind, …>` and not a `ReadonlySet`, a `string[]`
 * or an allow-list. AGENTS.md → Review Lessons states the trap verbatim: a side
 * inventory built from today's members still compiles when an eighth kind is
 * added, falls to a default branch, and silently changes the answer — here it
 * would render `0`, "injected nothing", for a kind nobody measured. Typing the
 * element is the floor, not the fix. A Record cannot be written without naming
 * every member, so an eighth kind fails `tsc` in this file until somebody
 * declares what its footprint is counted from.
 *
 * Sibling contract: `agent-component-output-declaration.ts` (ISS-10728) declares
 * each kind's NUMERATOR. This declares the DENOMINATOR's source. Same shape and
 * the same reason for it, deliberately two modules: a kind can rule `None` on
 * its output and still hold a real footprint, which is precisely the asymmetry
 * PRD-753 R6 depends on.
 */

import {
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "./agent-component-invocation.ts";

/**
 * Which text a kind's footprint is counted from — the shapes ISS-10736 §2 and
 * both schema comments already describe.
 *
 * Every member of the kind union declares a source. None reports "no footprint":
 * a footprint is what a component PUT INTO CONTEXT, and every kind that runs
 * puts something there, which is exactly why PRD-753 calls it the universal
 * denominator. "Nothing was captured for this invocation" is a property of the
 * ROW, carried as an absent value, never of the kind.
 */
export const AgentComponentFootprintSource = {
  /** The result payload injected into the consuming turn's context. */
  ResultPayload: "result_payload",
  /** The component's own definition body, injected verbatim when it ran. */
  DefinitionBody: "definition_body",
  /** The hook's stdout, injected into the turn that followed it. */
  HookStdout: "hook_stdout",
  /** The text the subagent returned to its parent — the only part that enters
   *  the parent's context. */
  ReturnedText: "returned_text",
} as const;
export type AgentComponentFootprintSource =
  (typeof AgentComponentFootprintSource)[keyof typeof AgentComponentFootprintSource];

export const AGENT_COMPONENT_FOOTPRINT_SOURCE: Record<
  AgentComponentInvocationKind,
  AgentComponentFootprintSource
> = {
  [AgentComponentInvocationKind.Tool]:
    AgentComponentFootprintSource.ResultPayload,
  [AgentComponentInvocationKind.Mcp]:
    AgentComponentFootprintSource.ResultPayload,
  /**
   * RULING (ISS-10736 §2, recorded rather than defaulted): `orchestration`
   * CARRIES ITS OWN FOOTPRINT and does not report none. It is a container in the
   * output sense — ISS-10728 rules its numerator `None` because its children
   * produce the work — but it is not a container on the wire: it reaches this
   * producer as a harness-kind `tool_use` with a result payload of its own, and
   * that payload is injected into the consuming turn exactly like any other
   * tool's. Reporting none would make a real, already-counted context cost
   * invisible. Its children's footprints are their own rows and are not summed
   * into it here, so nothing is double-counted at this grain.
   */
  [AgentComponentInvocationKind.Orchestration]:
    AgentComponentFootprintSource.ResultPayload,
  /** The expansion a command produces is its definition body, injected as the
   *  user turn's real content. */
  [AgentComponentInvocationKind.Command]:
    AgentComponentFootprintSource.DefinitionBody,
  [AgentComponentInvocationKind.Skill]:
    AgentComponentFootprintSource.DefinitionBody,
  [AgentComponentInvocationKind.Hook]: AgentComponentFootprintSource.HookStdout,
  [AgentComponentInvocationKind.Subagent]:
    AgentComponentFootprintSource.ReturnedText,
};

/** Average characters per token for ASCII/Latin text. */
const ASCII_CHARS_PER_TOKEN = 4;

/**
 * A footprint, with the label that says how it was arrived at.
 *
 * The two always travel together because the boundary requires it — an item
 * carrying any telemetry without `usageMeasurement` is rejected as
 * `telemetry_requires_usage_measurement` — and because ISS-7795's whole point is
 * that a count and a derivation are not comparable unless the derivation is
 * stated.
 */
export type AgentComponentFootprint = {
  readonly footprintTokens: number;
  readonly usageMeasurement: AgentComponentInvocationUsageMeasurement;
};

/**
 * Deterministic token estimate for a piece of injected text.
 *
 * Counts per CODE POINT, so astral characters (emoji) are not double-counted as
 * surrogate pairs: ASCII at ~4 characters per token, every non-ASCII code point
 * as a whole token. No tokenizer ships in this repo and no provider reports a
 * per-block count, so this is DERIVED, never observed — which is precisely
 * {@link AgentComponentInvocationUsageMeasurement.Estimated} by its own
 * definition ("anything derived rather than observed").
 *
 * Deliberately NOT the sibling estimator in `apps/api/app/documents/merge-service.ts`.
 * That one is documented as biased to over-count on purpose, because it guards a
 * context window and wants to reject borderline input; a metric that is biased
 * high is a wrong measurement, not a safe one. The arithmetic coincides today;
 * the contracts do not, and folding them would tie a published number to a
 * guard's safety margin.
 */
export function estimateAgentComponentFootprintTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) {
      asciiChars += 1;
    } else {
      nonAsciiChars += 1;
    }
  }
  return Math.ceil(asciiChars / ASCII_CHARS_PER_TOKEN) + nonAsciiChars;
}

/**
 * True when a number is a footprint this contract may persist.
 *
 * Covers the WHOLE impossible set for a token count, not the two that are easy
 * to remember. Negative and non-finite are the ones that get written; what
 * reaches the column is the rest — a FRACTIONAL count (`1.5` tokens), and a
 * magnitude past {@link AGENT_COMPONENT_INVOCATION_MAX_TOKENS}, which is the
 * safe-integer ceiling the wire schema already enforces and which sits well
 * inside the `BIGINT` both `footprint_tokens` columns declare (cloud Postgres
 * and desktop SQLite), so nothing valid here can clear this boundary and then
 * die at the column. Each of those renders as a confident real measurement,
 * which is worse than a refusal.
 */
export function isValidAgentComponentFootprintTokens(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= AGENT_COMPONENT_INVOCATION_MAX_TOKENS
  );
}

/**
 * Resolve one invocation's footprint from the text its kind is counted from.
 *
 * For the kinds whose source is a DEFINITION BODY, which is the text carried
 * whole all the way to the row. Every other kind's source is size-capped
 * somewhere between the transcript and this module — a tool result at 4 KiB, a
 * hook's stdout at the worker payload bound — so those kinds count at parse time
 * and arrive through {@link agentComponentFootprintFromTokenCount} instead. A
 * count taken over a capped prefix is a systematic UNDER-statement, not a
 * smaller sample of the right thing, and AGENTS.md's partial-results rule carves
 * exactly that out: a shortfall that biases the arithmetic is not publishable
 * with a caveat, because a caveat cannot unbias a value.
 *
 * Returns `undefined` — NOT a zero — when there is no text. NULL means "not
 * measured" and `0` means "measured, and it injected nothing" (PRD-753 R1), so
 * the two must never collapse.
 */
export function resolveAgentComponentFootprint(input: {
  text: string | null | undefined;
}): AgentComponentFootprint | undefined {
  if (input.text === null || input.text === undefined) {
    return undefined;
  }
  const footprintTokens = estimateAgentComponentFootprintTokens(input.text);
  if (!isValidAgentComponentFootprintTokens(footprintTokens)) {
    return undefined;
  }
  return {
    footprintTokens,
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
  };
}

/**
 * Wrap a footprint that was already counted upstream — the tool-result case,
 * where the count has to be taken at parse time because the payload the row
 * carries downstream is a byte-capped prefix of what was really injected.
 *
 * Refuses the same whole impossible set {@link isValidAgentComponentFootprintTokens}
 * covers, because the number arrives here across a persistence boundary (the
 * stored-event rebuild lane reads it back out of JSON) where the declared type
 * constrains nothing at runtime.
 */
export function agentComponentFootprintFromTokenCount(
  value: number | null | undefined
): AgentComponentFootprint | undefined {
  if (
    value === null ||
    value === undefined ||
    !isValidAgentComponentFootprintTokens(value)
  ) {
    return undefined;
  }
  return {
    footprintTokens: value,
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
  };
}
