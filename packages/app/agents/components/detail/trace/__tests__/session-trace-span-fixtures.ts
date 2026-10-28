import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import {
  buildSessionTrace,
  findSpanById,
} from "../../../../lib/session-trace/build-session-trace";
import type {
  SessionTraceInvocation,
  SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";

export const TRACE_ORIGIN_MS = Date.parse("2026-08-20T14:00:00.000Z");

/** One invocation `offsetMs` after the shared origin; a tool by default. */
export function traceInvocation(
  id: string,
  offsetMs: number,
  overrides: Partial<SessionTraceInvocation> = {}
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: `component-${id}`,
    sequence: offsetMs,
    invokedAt: new Date(TRACE_ORIGIN_MS + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

/** Build the tree from `rows` and return the placed span for `id`. */
export function spanFrom(
  rows: readonly SessionTraceInvocation[],
  id: string
): SessionTraceSpan {
  const span = findSpanById(buildSessionTrace(rows).roots, id);
  if (span === undefined) {
    throw new Error(`no span ${id}`);
  }
  return span;
}
