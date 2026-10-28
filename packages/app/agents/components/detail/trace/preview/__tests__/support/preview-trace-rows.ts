import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import {
  buildSessionTrace,
  findSpanById,
} from "../../../../../../lib/session-trace/build-session-trace";
import type {
  SessionTrace,
  SessionTraceInvocation,
  SessionTraceSpan,
} from "../../../../../../lib/session-trace/session-trace-node";
import type { PreviewSpanExtras } from "../../preview-traced-session";

const NON_DIGITS = /\D/g;

// The two ids the seeded findings ledger reports for: design-critic (11
// emitted, 4 invalidated) and visual-qa (6 emitted, 1 invalidated).
export const DESIGN_CRITIC_ID = "n14";
export const VISUAL_QA_ID = "n22";

const PREVIEW_TRACE_ORIGIN_MS = Date.parse("2026-08-20T14:00:00.000Z");

/**
 * A test row: the canonical invocation plus the two fields this sandbox
 * presumes.
 *
 * `detail` and `parentAgentId` are NOT on `SessionTraceInvocation` — they have
 * no producer, so they travel in the side table `preview-traced-session.ts`
 * builds, and the inspector takes them as a prop. A row may still carry them at
 * runtime (`buildSessionTrace` accepts the superset structurally and keeps only
 * the canonical half in the derived span's type), which is what lets one literal
 * seed both the trace and the extras a case needs.
 */
export type PreviewTraceTestRow = SessionTraceInvocation & PreviewSpanExtras;

/** One invocation row, placed `offsetMs` after the trace origin (null = unplaced). */
export function previewTraceRow(
  id: string,
  offsetMs: number | null,
  overrides: Partial<PreviewTraceTestRow> = {}
): PreviewTraceTestRow {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: id,
    sequence: Number(id.replace(NON_DIGITS, "")) || 0,
    invokedAt:
      offsetMs === null
        ? null
        : new Date(PREVIEW_TRACE_ORIGIN_MS + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

/** The presumed extras a row carries, in the shape the inspector takes. */
export function extrasOf(row: PreviewTraceTestRow): PreviewSpanExtras {
  return {
    ...(row.parentAgentId === undefined
      ? {}
      : { parentAgentId: row.parentAgentId }),
    ...(row.detail === undefined ? {} : { detail: row.detail }),
  };
}

/** The placed span for `id`, failing loudly rather than handing back undefined. */
export function spanIn(trace: SessionTrace, id: string): SessionTraceSpan {
  const span = findSpanById(trace.roots, id);
  if (span === undefined) {
    throw new Error(`No placed span ${id} in the test trace`);
  }
  return span;
}

/** Build a trace and return the span for `id` in one step. */
export function buildSpan(
  rows: readonly PreviewTraceTestRow[],
  id: string
): SessionTraceSpan {
  return spanIn(buildSessionTrace(rows), id);
}
