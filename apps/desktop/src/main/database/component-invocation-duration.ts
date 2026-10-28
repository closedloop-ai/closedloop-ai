import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  type AgentComponentInvocationDurationFields,
  invocationDurationFields,
} from "@repo/api/src/types/agent-component-invocation-duration";
import type {
  NormalizedSession,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";

/** Operator timing scope / ISS-10713: only matched call/result evidence is measured.
 * Skill dispatch completion is not skill execution time; commands and hooks have
 * no bracket here. Missing or ambiguous call identities remain inferred. */
export function stampInvocationDurations(
  session: NormalizedSession,
  candidates: AgentComponentInvocationCandidate[]
): void {
  const tools = toolsByCallIdentity(session);
  for (const candidate of candidates) {
    const tool = candidate.providerToolUseId
      ? tools.get(candidate.providerToolUseId)
      : undefined;
    if (tool === null) {
      candidate.durationMs = null;
    }
    if (!tool) {
      continue;
    }
    const timing = measuredToolInvocationTiming(
      candidate.componentKind,
      tool.timestamp,
      tool.resultTimestamp
    );
    if (timing.durationMs !== undefined) {
      candidate.invokedAt = tool.timestamp;
      candidate.durationMs = timing.durationMs;
    }
    if (timing.durationRefusedInvalidEvidence) {
      candidate.durationRefusedInvalidEvidence = true;
    }
  }
}

/** A refused bracket is unknown timing for that one call, never a failed set. */
export type InvocationTimingEvidence =
  AgentComponentInvocationDurationFields & {
    durationRefusedInvalidEvidence?: true;
  };

/** A missing result is normal for point-event harnesses and stays unknown.
 * Invalid source evidence drops only this call's duration; the row writer
 * reports the refused count (tamsinb review on #8910). */
export function measuredInvocationTiming(
  start: unknown,
  end: unknown
): InvocationTimingEvidence {
  if (
    start === null ||
    start === undefined ||
    end === null ||
    end === undefined
  ) {
    return {};
  }
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    start.trim() === "" ||
    end.trim() === ""
  ) {
    return { durationRefusedInvalidEvidence: true };
  }
  const elapsedMs = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    return { durationRefusedInvalidEvidence: true };
  }
  return invocationDurationFields(elapsedMs);
}

export function measuredToolInvocationTiming(
  kind: AgentComponentInvocationKind,
  start: unknown,
  end: unknown
): InvocationTimingEvidence {
  if (
    kind === AgentComponentInvocationKind.Skill ||
    kind === AgentComponentInvocationKind.Command ||
    kind === AgentComponentInvocationKind.Hook
  ) {
    return {};
  }
  return measuredInvocationTiming(start, end);
}

/** Contradictory durable witnesses cannot become a first-wins measurement.
 * Explicit null also prevents a prior measurement from being restored. */
export function omitAmbiguousInvocationTimings(
  candidates: AgentComponentInvocationCandidate[]
): AgentComponentInvocationCandidate[] {
  const witnesses = new Map<string, AgentComponentInvocationCandidate>();
  const ambiguousIds = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.providerToolUseId;
    if (!id) {
      continue;
    }
    const prior = witnesses.get(id);
    if (
      prior &&
      (prior.invokedAt !== candidate.invokedAt ||
        prior.durationMs !== candidate.durationMs)
    ) {
      ambiguousIds.add(id);
    }
    witnesses.set(id, candidate);
  }
  for (const candidate of candidates) {
    if (
      candidate.providerToolUseId &&
      ambiguousIds.has(candidate.providerToolUseId)
    ) {
      candidate.durationMs = null;
    }
  }
  return candidates;
}

/** Null marks a call identity whose witnesses disagree on start or result. */
function toolsByCallIdentity(
  session: NormalizedSession
): Map<string, NormalizedToolUse | null> {
  const tools = new Map<string, NormalizedToolUse | null>();
  for (const tool of [
    ...session.toolUses,
    ...(session.subagents ?? []).flatMap((agent) => agent.toolUses ?? []),
  ]) {
    const id = tool.providerToolUseId ?? tool.id;
    if (!id) {
      continue;
    }
    const prior = tools.get(id);
    if (prior === undefined) {
      tools.set(id, tool);
    } else if (
      prior !== null &&
      (prior.timestamp !== tool.timestamp ||
        prior.resultTimestamp !== tool.resultTimestamp)
    ) {
      tools.set(id, null);
    }
  }
  return tools;
}
