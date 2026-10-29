/**
 * @file component-invocation-line-reconciliation.ts
 * @description ISS-10730 — the per-invocation LINE attribution's two derived
 * concerns, extracted from `component-invocations.ts` (over the file-size
 * ceiling and shrink-only, root AGENTS.md): recovering a stored `diffDelta`
 * from an `events.data` row, and publishing what a session's attribution
 * actually covered.
 */

import {
  isValidInvocationLineCount,
  reconcileAttributedInvocationLines,
} from "@repo/api/src/types/agent-component-invocation-lines";
import { asRecord } from "@repo/lib/harness/parser-utils";
import type { NormalizedSession } from "../collectors/types.js";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";

/**
 * ISS-10730: the per-edit line delta the import wrote onto `events.data`.
 *
 * Reads `data.diffDelta` and nothing else, matching the fold
 * `agent-session-detail-projection` applies to this same field, so the trace
 * detail and this reconciliation can never disagree about what a row recorded.
 * ISS-11084 retired a second `tool_input.diffDelta` arm from both folds
 * together: `diffDelta` is a value the PARSER computes FROM a tool's input and
 * is never carried inside it, so no build has written that shape — every
 * writer keeps the two as siblings (`import-metadata-builders` sets
 * `payload.diffDelta` and `detail.tool_input` separately). Returning
 * `undefined` rather than a zeroed pair keeps "no delta recorded" distinct from
 * "this call changed nothing"; the validity gate itself lives in
 * `invocationLineColumns`, so this function never decides what is storable.
 */
export function storedDiffDelta(
  data: Record<string, unknown> | null
): { add: number; del: number } | undefined {
  const delta = asRecord(data?.diffDelta);
  if (!delta) {
    return;
  }
  const add = delta.add;
  const del = delta.del;
  return typeof add === "number" && typeof del === "number"
    ? { add, del }
    : undefined;
}

/**
 * ISS-10730: publish what the session's line attribution actually covered.
 *
 * The residual — lines the session's own `diffStats` claims that no invocation
 * claims — is PUBLISHED rather than absorbed. Folding it into an invocation
 * would attribute lines to a component that did not produce them; dropping it
 * would let the parts silently fail to sum to the whole, which is the failure
 * an attributed total is most likely to hide. Unjoinable mutating calls (a
 * `diffDelta` on a call the transcript gave no `providerToolUseId`) are COUNTED
 * for the same reason, and their lines stay inside that residual.
 *
 * Reported through the import log the row writer already uses for the dropped
 * `agent_id` and refused-telemetry diagnostics, bounded to one line per
 * session, carrying counts only and never a file path or a row identity. A
 * session whose `diffStats` is absent says so rather than reporting a zero
 * residual: unknown is not zero.
 */
export function reportInvocationLineReconciliation(
  session: NormalizedSession,
  candidates: readonly AgentComponentInvocationCandidate[],
  log: (message: string) => void
): void {
  const contributions = candidates
    .filter(
      (candidate) =>
        candidate.linesAdded !== null && candidate.linesRemoved !== null
    )
    .map((candidate) => ({
      providerToolUseId: candidate.providerToolUseId,
      linesAdded: candidate.linesAdded as number,
      linesRemoved: candidate.linesRemoved as number,
    }));
  // Only the calls NO candidate already contributed for. An id-less mutating
  // call still PRODUCES a candidate — `toolInvocationCandidate` falls back to a
  // synthetic `externalInvocationId` and leaves `providerToolUseId` null, and
  // `invocationLineColumns` gates on kind + validity and never on the id — so
  // that call is already in `contributions` with a null id and
  // `reconcileAttributedInvocationLines` has already counted it unjoinable.
  // Counting it again here reported 2 unjoinable calls for 1 call and showed its
  // lines as unclaimed residual while the row holding them sat in
  // `agent_component_invocations` (#7718 review). What the candidate genuinely
  // refuses is an INVALID delta, which is exactly the remaining set.
  const unjoinableDeltaCalls = (session.toolUses ?? []).filter(
    (toolUse) =>
      toolUse.diffDelta != null &&
      !(toolUse.providerToolUseId ?? toolUse.id ?? "") &&
      !(
        isValidInvocationLineCount(toolUse.diffDelta.add) &&
        isValidInvocationLineCount(toolUse.diffDelta.del)
      )
  ).length;
  if (contributions.length === 0 && unjoinableDeltaCalls === 0) {
    return;
  }
  const reconciliation = reconcileAttributedInvocationLines(
    [
      ...contributions,
      // A mutating call whose delta the candidate REFUSED joins to no invocation
      // and carries no storable count. It is counted rather than dropped, as a
      // zero-line unjoinable member, and the lines it changed surface in the
      // residual. A call the candidate accepted is already above.
      ...Array.from({ length: unjoinableDeltaCalls }, () => ({
        providerToolUseId: null,
        linesAdded: 0,
        linesRemoved: 0,
      })),
    ],
    session.diffStats
      ? {
          linesAdded: session.diffStats.linesAdded,
          linesRemoved: session.diffStats.linesRemoved,
        }
      : null
  );
  const residual = reconciliation.sessionLinesKnown
    ? `residual +${reconciliation.residualAdded}/-${reconciliation.residualRemoved}`
    : "residual unknown (session reported no diffStats)";
  log(
    `component_invocations ${session.sessionId}: attributed +${reconciliation.attributedAdded}/-${reconciliation.attributedRemoved} across ${reconciliation.attributedCalls} invocation(s), ${reconciliation.unjoinableCalls} unjoinable mutating call(s), ${residual}`
  );
}
