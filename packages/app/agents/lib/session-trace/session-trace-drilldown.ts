/**
 * @file session-trace-drilldown.ts
 * @description FOCUS: re-root the chart on one span, and the trail back out.
 *
 * A subtree twelve levels down gets the whole axis to itself, and the ancestor
 * trail comes with it so going back up is a breadcrumb rather than a guess.
 *
 * The prototype's SECOND drill-in — "what does this component do EVERYWHERE in
 * this session" — is deliberately not here. ISS-10737 ships the tab and its
 * focus drill-in; the component view needs an entry point and a surface of its
 * own, and porting its derivation with nothing that could call it would have
 * shipped an unreachable module plus a `?component=` parameter that renders the
 * ordinary tree. It is tracked separately rather than half-landed.
 */

import type { SessionTraceSpan } from "./session-trace-node";

export type SessionTraceFocusView = {
  /** The spans to draw. The focused subtree alone, or the whole tree. */
  roots: readonly SessionTraceSpan[];
  /** Ancestors of the focused span, outermost first. Empty when unfocused. */
  trail: readonly SessionTraceSpan[];
  /** Window the chart should show, tight to the focused subtree. */
  windowFromMs: number;
  windowToMs: number;
  focused: SessionTraceSpan | null;
};

export function resolveFocusView(
  roots: readonly SessionTraceSpan[],
  focusId: string | null,
  totalMs: number
): SessionTraceFocusView {
  const unfocused: SessionTraceFocusView = {
    roots,
    trail: [],
    windowFromMs: 0,
    windowToMs: totalMs,
    focused: null,
  };
  if (focusId === null) {
    return unfocused;
  }
  const path = findSpanPath(roots, focusId);
  if (path === null) {
    return unfocused;
  }
  const focused = path.at(-1);
  if (focused === undefined) {
    return unfocused;
  }
  return {
    roots: [focused],
    trail: path.slice(0, -1),
    windowFromMs: focused.startMs,
    // A zero-width subtree would give the axis nothing to divide by, so a
    // focused instant still gets a readable sliver.
    windowToMs: Math.max(focused.endMs, focused.startMs + 1),
    focused,
  };
}

/**
 * The chain of spans from a root down to `spanId`, inclusive.
 *
 * Iterative, like every other walk over this tree: the depth is a property of
 * collected data, and this one runs inside a render, so a deep chain must not be
 * able to overflow the stack.
 */
export function findSpanPath(
  spans: readonly SessionTraceSpan[],
  spanId: string
): readonly SessionTraceSpan[] | null {
  const stack: {
    span: SessionTraceSpan;
    trail: readonly SessionTraceSpan[];
  }[] = [];
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span !== undefined) {
      stack.push({ span, trail: [] });
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    const path = [...frame.trail, frame.span];
    if (frame.span.invocation.externalInvocationId === spanId) {
      return path;
    }
    for (let index = frame.span.children.length - 1; index >= 0; index -= 1) {
      const child = frame.span.children[index];
      if (child !== undefined) {
        stack.push({ span: child, trail: path });
      }
    }
  }
  return null;
}
