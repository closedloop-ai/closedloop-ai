/**
 * @file session-trace-disclosure.ts
 * @description What the Trace tab is REQUIRED to say about its own operands
 * (ISS-10737; DOC-37 sections 2, 6, 7; PRD-753 R1/R9).
 *
 * THE RULE THIS FILE ENFORCES. A slot whose operand has no producer names the
 * operand. It does not render a bare dash, and it never renders a zero — a
 * measured zero ("this ran and produced nothing") and an unmeasured one ("no
 * ingest covered this") are different facts, and collapsing them publishes a
 * number the producer never stated. The tab's own dependencies are exactly the
 * case: `succeeded`, the token vector, `estimatedCost`, `footprintTokens` and
 * `usageMeasurement` are real columns that ride the invocation sync item and are
 * absent from the read row until ISS-10718; no column anywhere holds a
 * per-invocation elapsed span until ISS-10713; and the persisted ancestry is
 * depth-1 until ISS-10714.
 *
 * EVERY SENTENCE BELOW IS DERIVED FROM THE DATA IN HAND, never from the ticket
 * list. `costReportedCount === 0` is what makes the cost line appear, so the day
 * ISS-10718 lands on one harness and not another, this says so for the rows that
 * actually lack it rather than restating a stale claim about the whole world.
 * The owning ticket is named in the comment above each sentence, never inside
 * the sentence: what ships to a reader is what is unknown, not which ticket owns
 * supplying it.
 */

import type { AgentComponentInvocationSessionTreeBound } from "@repo/api/src/types/agent-component-invocation-session-tree";
import { formatSessionTraceCount } from "./session-trace-format";
import type { SessionTrace } from "./session-trace-node";

/**
 * One operand the surface could not resolve.
 *
 * `label` and `note` are USER-FACING copy, so they carry no field name, no
 * ticket slug and no document reference: those are implementation provenance
 * with no user job, and the reader's question is "is this zero, or unknown".
 * The owning ticket lives in this file's comments, where the next engineer
 * reads it.
 */
export type SessionTraceMissingOperand = {
  /** Stable id, so a slot can ask for its own operand's sentence. */
  operand: SessionTraceOperand;
  /** What is missing, in the reader's words. Never "unavailable". */
  label: string;
  /** One sentence: what has no producer, and which ticket owns it. */
  note: string;
};

export const SessionTraceOperand = {
  Extent: "extent",
  Failure: "failure",
  TurnSpend: "turnSpend",
  TurnTokens: "turnTokens",
  Footprint: "footprint",
  Ancestry: "ancestry",
} as const;
export type SessionTraceOperand =
  (typeof SessionTraceOperand)[keyof typeof SessionTraceOperand];

export type SessionTraceDisclosure = {
  /** The extent-coverage sentence. Always present — it qualifies every bar. */
  extentCoverage: string;
  /** Every operand with no producer for this session's rows. */
  missing: readonly SessionTraceMissingOperand[];
  /**
   * The clip sentence, or `null` on a complete tree. Non-null means rows were
   * withheld, so the ancestry on screen is WRONG for some subtree rather than
   * merely short — which is why it is stated rather than left to a row count.
   */
  truncation: string | null;
};

/**
 * WHY A CLIPPED TREE GETS ITS OWN SENTENCE AND NOT A FOOTNOTE. Dropping a row
 * orphans every descendant of it: they re-root at the top level and report an
 * ancestry chain that is wrong rather than incomplete, and the ancestry chain is
 * what this surface exists to answer (DOC-37 section 1).
 */
export function buildSessionTraceDisclosure(
  trace: SessionTrace,
  bound: AgentComponentInvocationSessionTreeBound
): SessionTraceDisclosure {
  return {
    extentCoverage: extentCoverageSentence(trace),
    missing: collectMissingOperands(trace),
    truncation: bound.truncated
      ? `${formatSessionTraceCount(bound.droppedCount)} of this session's invocations are not in this tree: the read stopped after ${formatSessionTraceCount(bound.maxPages)} pages. Any span whose parent is among them is drawn at the top level, so its ancestry here is wrong, not merely short.`
      : null,
  };
}

/** The sentence above the chart that qualifies every bar's width. */
function extentCoverageSentence(trace: SessionTrace): string {
  const placed = trace.spanCount;
  if (placed === 0) {
    return "No invocation in this session carries a readable timestamp, so none can be placed on a time axis. They are listed below in session order instead.";
  }
  if (trace.measuredSpanCount === 0) {
    // ISS-10713 records a per-invocation elapsed span.
    return `No bar's width is measured: nothing records how long a call took yet, so all ${formatSessionTraceCount(placed)} run to the next call or to the close of the one that made them. Read every width as an upper bound on latency, not as latency.`;
  }
  if (trace.inferredSpanCount === 0) {
    return `All ${formatSessionTraceCount(placed)} bar widths are measured elapsed spans.`;
  }
  return `${formatSessionTraceCount(trace.measuredSpanCount)} of ${formatSessionTraceCount(placed)} bar widths are measured elapsed spans. The other ${formatSessionTraceCount(trace.inferredSpanCount)} are hatched: they run to the next sibling or the parent's close, which is an upper bound on latency, not latency.`;
}

function collectMissingOperands(
  trace: SessionTrace
): readonly SessionTraceMissingOperand[] {
  const missing: SessionTraceMissingOperand[] = [];
  if (trace.succeededReportedCount === 0 && trace.spanCount > 0) {
    missing.push({
      operand: SessionTraceOperand.Failure,
      label: "Failures not recorded",
      // ISS-10718 widens the read row with `succeeded`.
      note: "Nothing on this session reports whether a call succeeded or failed, so the failure count is unknown rather than zero. No span is shown as having succeeded either.",
    });
  }
  if (trace.costReportedCount === 0 && trace.spanCount > 0) {
    missing.push({
      operand: SessionTraceOperand.TurnSpend,
      label: "Turn spend not recorded",
      // ISS-10718 widens the read row with the per-invocation cost.
      note: "Nothing on this session reports what a call cost. This is not a session that cost nothing.",
    });
  }
  if (trace.turnTokenReportedCount === 0 && trace.spanCount > 0) {
    missing.push({
      operand: SessionTraceOperand.TurnTokens,
      label: "Turn tokens not recorded",
      // ISS-10718 widens the read row with the token vector.
      note: "Nothing on this session reports input or output tokens. Turn tokens are a separate count from context footprint and the two are never added together.",
    });
  }
  if (trace.footprintReportedCount === 0 && trace.spanCount > 0) {
    missing.push({
      operand: SessionTraceOperand.Footprint,
      label: "Context footprint not recorded",
      // ISS-10718 widens the read row with `footprintTokens`.
      note: "Nothing on this session reports how much context a call added to the turns that consumed it.",
    });
  }
  if (trace.maxDepth === 0 && trace.spanCount > 1) {
    missing.push({
      operand: SessionTraceOperand.Ancestry,
      label: "Ancestry is flat",
      // ISS-10714 persists the full ancestry; until then the tree is depth-1.
      note: "Every call on this session is recorded at the top level: no parent was captured, so this tree has one level and the hand-off between calls cannot be shown yet.",
    });
  }
  return missing;
}
