/**
 * @file session-trace-route-state.ts
 * @description The deep link. A span, a window, and a lens survive a copied URL.
 *
 * A trace view whose state lives only in memory cannot be cited, and a finding
 * nobody else can open is not evidence. Every control that changes what the
 * chart asserts is therefore in the URL: which span is selected, which slice of
 * the axis is shown, which kinds are in scope, and whether the critical-path
 * lens is on. The params are read defensively — an out-of-range window or an
 * unknown kind falls back rather than throwing, because a pasted link is
 * untrusted input.
 */

import type { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { SESSION_TRACE_KIND_ORDER } from "./session-trace-node";

export const SessionTraceParam = {
  Span: "span",
  From: "from",
  To: "to",
  Kinds: "kinds",
  CriticalPath: "critical",
  Focus: "focus",
  ErrorsOnly: "errors",
} as const;
export type SessionTraceParam =
  (typeof SessionTraceParam)[keyof typeof SessionTraceParam];

export type SessionTraceRouteState = {
  spanId: string | null;
  windowFromMs: number | null;
  windowToMs: number | null;
  kinds: readonly AgentComponentInvocationKind[] | null;
  criticalPathOnly: boolean;
  /** Re-root the chart on this span. */
  focusId: string | null;
  /**
   * Narrow to failures. Keeps each failure's ANCESTORS too — a list of bare
   * leaves would drop the hand-off and fan-out that the drill-down came to find.
   */
  errorsOnly: boolean;
};

const KIND_SEPARATOR = ",";
const TRUE_VALUE = "1";

export function emptySessionTraceRouteState(): SessionTraceRouteState {
  return {
    spanId: null,
    windowFromMs: null,
    windowToMs: null,
    kinds: null,
    criticalPathOnly: false,
    focusId: null,
    errorsOnly: false,
  };
}

export function readSessionTraceRouteState(
  search: string
): SessionTraceRouteState {
  const params = new URLSearchParams(search);
  const from = readFiniteMs(params.get(SessionTraceParam.From));
  const to = readFiniteMs(params.get(SessionTraceParam.To));
  return {
    spanId: params.get(SessionTraceParam.Span),
    // A window is only meaningful as an ordered pair, so half of one is no
    // window at all rather than a silently repaired one.
    windowFromMs: from !== null && to !== null && to > from ? from : null,
    windowToMs: from !== null && to !== null && to > from ? to : null,
    kinds: readKinds(params.get(SessionTraceParam.Kinds)),
    criticalPathOnly: params.get(SessionTraceParam.CriticalPath) === TRUE_VALUE,
    focusId: params.get(SessionTraceParam.Focus),
    errorsOnly: params.get(SessionTraceParam.ErrorsOnly) === TRUE_VALUE,
  };
}

/** Serialize back to a query string, omitting every default. */
export function writeSessionTraceRouteState(
  state: SessionTraceRouteState,
  search: string
): string {
  const params = new URLSearchParams(search);
  setOrDelete(params, SessionTraceParam.Span, state.spanId);
  setOrDelete(
    params,
    SessionTraceParam.From,
    state.windowFromMs === null ? null : String(Math.round(state.windowFromMs))
  );
  setOrDelete(
    params,
    SessionTraceParam.To,
    state.windowToMs === null ? null : String(Math.round(state.windowToMs))
  );
  setOrDelete(
    params,
    SessionTraceParam.Kinds,
    state.kinds === null ||
      state.kinds.length === SESSION_TRACE_KIND_ORDER.length
      ? null
      : state.kinds.join(KIND_SEPARATOR)
  );
  setOrDelete(
    params,
    SessionTraceParam.CriticalPath,
    state.criticalPathOnly ? TRUE_VALUE : null
  );
  setOrDelete(params, SessionTraceParam.Focus, state.focusId);
  setOrDelete(
    params,
    SessionTraceParam.ErrorsOnly,
    state.errorsOnly ? TRUE_VALUE : null
  );
  const next = params.toString();
  return next.length > 0 ? `?${next}` : "";
}

function setOrDelete(
  params: URLSearchParams,
  key: string,
  value: string | null
): void {
  if (value === null || value.length === 0) {
    params.delete(key);
    return;
  }
  params.set(key, value);
}

function readFiniteMs(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function readKinds(
  raw: string | null
): readonly AgentComponentInvocationKind[] | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  const known = new Set<string>(SESSION_TRACE_KIND_ORDER);
  const kinds = raw
    .split(KIND_SEPARATOR)
    .filter((value): value is AgentComponentInvocationKind => known.has(value));
  return kinds.length > 0 ? kinds : null;
}
