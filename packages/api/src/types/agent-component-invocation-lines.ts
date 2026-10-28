/**
 * ISS-10730 — per-INVOCATION line attribution: the lines an individual
 * component invocation changed, at the same grain cost already sits at.
 *
 * WHY THIS GRAIN. `SessionDetail.linesAdded/linesRemoved` and
 * `NormalizedDiffStats` are whole-session totals, so `locPerDollarForKind`
 * divides every component's share of a session's lines by that component's
 * cost — the "Directional — a session-level metric, not caused by one
 * component" disclaimer on the KLOC/$ card. A per-invocation cost divided by a
 * per-session line count is a wrong number that looks plausible; attribution
 * and outcome have to share one grain.
 *
 * WHAT A "LINE PRODUCED" IS. Deliberately NOT a new definition: it is
 * `NormalizedToolUse.diffDelta`, the per-edit `{ add, del }` the Claude, Codex
 * and OpenCode parsers already compute from an `Edit`/`Write`/`MultiEdit` (or
 * `apply_patch`/`patch`) call's own before/after content, and which already
 * sums into the session `diffStats` this attribution reconciles against. Any
 * second definition here would put two "lines changed" numbers in the product
 * that cannot be reconciled with each other.
 *
 * MOVED VERSUS REAL LINES ARE NOT SPLIT HERE, and that is a property of the
 * grain rather than an omission. A refactor that relocates a block verbatim is
 * one `Edit` deleting it and one `Write` adding it; whether those lines later
 * SURVIVE is a `git blame` fact about the tree at a later date, not a fact the
 * transcript holds at the moment the call ran. ISS-10731 owns that split and
 * takes it from `.claude/skills/code-stickiness/`, whose OLD-side churn
 * classification is the only place in this repo that can see it. Splitting here
 * would also break the reconciliation below, whose whole point is that the
 * attributed parts and the session total are the same measurement.
 *
 * ATTRIBUTION DOES NOT NEST. Lines land on the invocation that MADE the call —
 * the `tool`/`mcp`/`orchestration` row whose `providerToolUseId` is that call's
 * id — and are never also copied onto the subagent that ran it. That keeps the
 * persisted set non-overlapping, which is what makes {@link
 * reconcileAttributedInvocationLines} possible at all: a subtree roll-up is a
 * read-time SUM over an agent's own invocations, not a second stored copy.
 * Same rule the per-invocation `estimatedCost` docs already state for a
 * subagent turn's cost inside its parent session's total.
 *
 * Lightweight and dependency-free (no Zod) so a bundle-sensitive client can
 * import the coverage vocabulary without the ingest boundary's graph.
 */

import { POSTGRES_INT4_MAX } from "@closedloop-ai/loops-api/column-limits";

/**
 * The largest line count either column can hold.
 *
 * The int4 ceiling, NOT the safe-integer ceiling the token counts take — the
 * token columns are `BigInt`, these are `Int`. A value between int4 max and
 * `Number.MAX_SAFE_INTEGER` would clear a safe-integer check, clear the wire
 * `.strict()` boundary, write happily into SQLite (whose INTEGER affinity
 * ignores the Prisma-declared width), and only fail at the cloud `createMany`
 * as an out-of-range `integer` — an exception outside
 * `AgentComponentInvocationSyncRejectReason`, so it surfaces as a bare 500 the
 * client cannot classify and the generation retries forever without converging.
 * Bounding it here turns that poison pill into an ordinary validation failure
 * the classification scheme already understands, and matches what
 * `session-artifact-link.ts` already does for its own int4-backed
 * `linesAdded`/`linesRemoved`.
 *
 * Taken from `@closedloop-ai/loops-api/column-limits`, the import-free canonical owner of
 * the int4 ceiling, NOT from `session-artifact-link.ts`'s `PR_INT_MAX` alias —
 * which derives from this same constant but reaches it through a module that
 * imports Zod. This file states it is dependency-free so a bundle-sensitive
 * client can import the coverage vocabulary, and `packages/app`'s data source
 * imports `InvocationLocPerDollarUncoveredOperand` as a RUNTIME value, so
 * routing a number through the heavier module would have pulled Zod into that
 * client graph for a literal.
 */
export const AGENT_COMPONENT_INVOCATION_MAX_LINES = POSTGRES_INT4_MAX;

/**
 * Whether a value is a line count this boundary may persist.
 *
 * Covers the WHOLE impossible set for the domain, not the two everyone
 * remembers. Each rejected shape renders as a confident real measurement, which
 * is worse than a refusal:
 *
 * - not a number at all (a TEXT cell handed back by `$queryRawUnsafe`);
 * - `NaN` / `±Infinity` — `Infinity < 0` is false, so a comparison-only guard
 *   admits both;
 * - negative — a count has no negative member;
 * - FRACTIONAL — `1.5` lines is not a smaller number, it is a parse that went
 *   wrong; `Number.isSafeInteger` is what rejects it, not a range check;
 * - past the safe-integer ceiling, where JSON round-tripping stops being exact.
 *
 * A blank string is covered by the `typeof` arm rather than by a coercion:
 * `Number("")` is a measured `0`, which is exactly the fabricated value this
 * predicate exists to keep out of the column.
 */
export function isValidInvocationLineCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= AGENT_COMPONENT_INVOCATION_MAX_LINES
  );
}

/** Every per-invocation line-attribution key. */
export const AGENT_COMPONENT_INVOCATION_LINE_KEYS = [
  "linesAdded",
  "linesRemoved",
] as const;

/** True when the item carries either half of a line attribution. */
export function hasAgentComponentInvocationLines(item: {
  linesAdded?: number;
  linesRemoved?: number;
}): boolean {
  return AGENT_COMPONENT_INVOCATION_LINE_KEYS.some(
    (key) => item[key] !== undefined
  );
}

/** One tool call's contribution, as the reconciliation below consumes it. */
export type InvocationLineContribution = {
  /** The call's own harness id; absent when the transcript recorded none. */
  providerToolUseId?: string | null;
  linesAdded: number;
  linesRemoved: number;
};

/**
 * What a session's line attribution actually covered.
 *
 * `residualAdded`/`residualRemoved` are the lines the session's own
 * `diffStats` claims that NO invocation claims. They are PUBLISHED rather than
 * absorbed: folding them into an invocation would attribute lines to a
 * component that did not produce them, and dropping them would make the parts
 * silently fail to sum to the whole. A negative residual is impossible in a
 * consistent session and is therefore reported as-is rather than clamped to
 * zero — clamping would hide the exact disagreement this field exists to
 * surface. `sessionLinesKnown: false` says the session has no `diffStats` at
 * all, which is UNKNOWN and not a residual of zero.
 *
 * `unjoinableCalls` counts the mutating calls whose lines could not be joined
 * to an invocation through `providerToolUseId`. Their lines stay inside the
 * residual — counted, never dropped.
 */
export type InvocationLineReconciliation = {
  attributedAdded: number;
  attributedRemoved: number;
  attributedCalls: number;
  unjoinableCalls: number;
  sessionLinesKnown: boolean;
  residualAdded: number | null;
  residualRemoved: number | null;
};

/**
 * Fold a session's mutating tool calls into the attributed total, the
 * unjoinable count, and the residual against the session's own `diffStats`.
 *
 * A contribution whose counts are not both valid is neither attributed nor
 * counted as unjoinable — it is not a measurement at all, and `invalidCalls`
 * would be a fourth population this ticket does not ask for. It still shows up,
 * honestly, as residual: the session total continues to include those lines
 * while no invocation claims them.
 */
export function reconcileAttributedInvocationLines(
  contributions: readonly InvocationLineContribution[],
  sessionLines: { linesAdded: number; linesRemoved: number } | null
): InvocationLineReconciliation {
  let attributedAdded = 0;
  let attributedRemoved = 0;
  let attributedCalls = 0;
  let unjoinableCalls = 0;
  for (const contribution of contributions) {
    if (
      !(
        isValidInvocationLineCount(contribution.linesAdded) &&
        isValidInvocationLineCount(contribution.linesRemoved)
      )
    ) {
      continue;
    }
    if (
      contribution.providerToolUseId === undefined ||
      contribution.providerToolUseId === null ||
      contribution.providerToolUseId.length === 0
    ) {
      unjoinableCalls += 1;
      continue;
    }
    attributedAdded += contribution.linesAdded;
    attributedRemoved += contribution.linesRemoved;
    attributedCalls += 1;
  }
  const sessionLinesKnown =
    sessionLines !== null &&
    isValidInvocationLineCount(sessionLines.linesAdded) &&
    isValidInvocationLineCount(sessionLines.linesRemoved);
  return {
    attributedAdded,
    attributedRemoved,
    attributedCalls,
    unjoinableCalls,
    sessionLinesKnown,
    residualAdded: sessionLinesKnown
      ? (sessionLines as { linesAdded: number }).linesAdded - attributedAdded
      : null,
    residualRemoved: sessionLinesKnown
      ? (sessionLines as { linesRemoved: number }).linesRemoved -
        attributedRemoved
      : null,
  };
}

/**
 * The operand a per-component LOC/$ ratio could not cover, named where the
 * ratio would have rendered.
 *
 * A silently absent slot is the same defect wearing a label (root AGENTS.md,
 * "Never Delete a Capability You Cannot Compute"), so a suppression always
 * says WHICH half was missing rather than leaving a bare `null`.
 */
export const InvocationLocPerDollarUncoveredOperand = {
  /** Lines resolved for this component; its spend did not. */
  Cost: "cost",
  /** Spend resolved for this component; its lines did not. */
  Lines: "lines",
  /** Neither operand resolved — nothing was measured for this component. */
  Both: "both",
} as const;
export type InvocationLocPerDollarUncoveredOperand =
  (typeof InvocationLocPerDollarUncoveredOperand)[keyof typeof InvocationLocPerDollarUncoveredOperand];

/**
 * The ratio, or the named reason it was withheld. Never a bare `null`.
 *
 * `undefinedRatio` is NOT a suppression and is deliberately its own state: both
 * operands were covered and the spend was MEASURED at exactly $0, so there is
 * no ratio to take rather than an operand that failed to resolve. Folding it
 * into `suppressed` with `uncoveredOperand: "cost"` would tell a reader the
 * spend is unknown for a component whose spend is known — the measured-zero
 * collapse ISS-9980 already ruled against for this metric family
 * (`locPerDollarFromCoercedLines`).
 */
export type InvocationLocPerDollarResult =
  | { state: "resolved"; locPerDollar: number }
  | { state: "undefinedRatio"; reason: "zero_cost" }
  | {
      state: "suppressed";
      uncoveredOperand: InvocationLocPerDollarUncoveredOperand;
    };

/**
 * Per-component LOC/$ from operands taken at the SAME grain, suppressed only
 * where the two cohorts genuinely do not cover each other.
 *
 * This is the narrow carve-out in "Never Delete a Capability You Cannot
 * Compute", not a violation of it. `LINE_BEARING_INVOCATION_KINDS` and
 * `USAGE_BEARING_INVOCATION_KINDS` are disjoint, so a component whose lines
 * resolve while its cost does not would divide real lines by an understated
 * denominator — an INFLATED number, not an incomplete one, and a caveat cannot
 * unbias it. The shortfall sits BETWEEN the operands rather than narrowing a
 * sample, which is exactly the condition `isLocPerDollarCoverageIncomplete`
 * suppresses the Sessions ratio under.
 *
 * The LINE COUNT itself is never suppressed by this: it is a real number over a
 * valid population and is published on its own (see the wire item's
 * `linesAdded`/`linesRemoved`, emitted whenever they resolve) whether or not
 * the ratio is withheld.
 *
 * A measured cost of exactly `0` is a real figure and NOT an uncovered operand.
 * It returns `undefinedRatio`, never a suppression naming `cost`: dividing by it
 * would fabricate `Infinity`, and calling its spend uncovered would report a
 * measured figure as unknown.
 */
export function resolveInvocationLocPerDollar(input: {
  lines: number | null;
  costUsd: number | null;
}): InvocationLocPerDollarResult {
  const linesCovered = isValidInvocationLineCount(input.lines);
  const costCovered =
    input.costUsd !== null &&
    Number.isFinite(input.costUsd) &&
    input.costUsd >= 0;
  if (linesCovered && costCovered) {
    const costUsd = input.costUsd as number;
    if (costUsd === 0) {
      return { state: "undefinedRatio", reason: "zero_cost" };
    }
    return {
      state: "resolved",
      locPerDollar: (input.lines as number) / costUsd,
    };
  }
  if (linesCovered) {
    return {
      state: "suppressed",
      uncoveredOperand: InvocationLocPerDollarUncoveredOperand.Cost,
    };
  }
  if (costCovered) {
    return {
      state: "suppressed",
      uncoveredOperand: InvocationLocPerDollarUncoveredOperand.Lines,
    };
  }
  return {
    state: "suppressed",
    uncoveredOperand: InvocationLocPerDollarUncoveredOperand.Both,
  };
}
