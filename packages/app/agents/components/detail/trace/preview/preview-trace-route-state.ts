/**
 * @file preview-trace-route-state.ts
 * @description The sandbox's view state: the canonical trace route state, plus
 * the one parameter production does not have.
 *
 * THE PARSER IS NOT REDECLARED HERE (ISS-11819). Reading and writing `span`,
 * `from`, `to`, `kinds`, `critical`, `focus` and `errors` — including the
 * defensive handling of a pasted half-window and an unknown kind — is
 * `session-trace-route-state.ts` in the sessions slice, which production also
 * uses. This module adds `component` and delegates everything else, so the two
 * surfaces cannot disagree about what a deep link means.
 *
 * WHY `component` IS NOT IN THE CANONICAL SET. The component drill-in is a
 * sandbox capability: production ships the focus drill-in only, and
 * `session-trace-drilldown.ts` records why — porting the derivation with nothing
 * that could call it would have shipped an unreachable module plus a
 * `?component=` parameter that renders the ordinary tree. Keeping the parameter
 * on this side means a production deep link cannot carry a selector production
 * ignores.
 */

import {
  readSessionTraceRouteState,
  type SessionTraceRouteState,
  writeSessionTraceRouteState,
} from "../../../../lib/session-trace/session-trace-route-state";

/** The sandbox-only parameter. The canonical names live on `SessionTraceParam`. */
export const PreviewTraceParam = {
  Span: "span",
  From: "from",
  To: "to",
  Kinds: "kinds",
  CriticalPath: "critical",
  Focus: "focus",
  ErrorsOnly: "errors",
  /** Leave the tree for one component's whole footprint, as `kind:key`. */
  Component: "component",
} as const;
export type PreviewTraceParam =
  (typeof PreviewTraceParam)[keyof typeof PreviewTraceParam];

export type PreviewTraceRouteState = SessionTraceRouteState & {
  /** Leave the tree for one component's whole footprint, as `kind:key`. */
  componentRef: string | null;
};

export function emptyPreviewTraceRouteState(): PreviewTraceRouteState {
  return {
    spanId: null,
    windowFromMs: null,
    windowToMs: null,
    kinds: null,
    criticalPathOnly: false,
    focusId: null,
    errorsOnly: false,
    componentRef: null,
  };
}

export function readPreviewTraceRouteState(
  search: string
): PreviewTraceRouteState {
  const params = new URLSearchParams(search);
  return {
    ...readSessionTraceRouteState(search),
    componentRef: params.get(PreviewTraceParam.Component),
  };
}

/** Serialize back to a query string, omitting every default. */
export function writePreviewTraceRouteState(
  state: PreviewTraceRouteState,
  search: string
): string {
  // The canonical writer owns every shared parameter, including deleting the
  // ones that are at their default, so this only has to settle `component`.
  const canonical = writeSessionTraceRouteState(state, search);
  const params = new URLSearchParams(
    canonical.startsWith("?") ? canonical.slice(1) : canonical
  );
  if (state.componentRef === null || state.componentRef.length === 0) {
    params.delete(PreviewTraceParam.Component);
  } else {
    params.set(PreviewTraceParam.Component, state.componentRef);
  }
  const next = params.toString();
  return next.length > 0 ? `?${next}` : "";
}
