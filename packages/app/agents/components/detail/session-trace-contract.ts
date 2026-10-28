import type { TraceTextAnchor } from "./trace-comments";

/** Imperative navigation contract shared with trace containers. */
export type SessionTraceHandle = {
  scrollToRow(row: number): void;
  /**
   * ISS-12276: make sure the group holding `row` is in the DOM before a caller
   * measures it. Returns `true` when it already is (always, for a trace that is
   * not windowed). Otherwise it moves the scroller to the group's estimated
   * offset, when the virtualizer has one, and returns `false`; the caller
   * measures again after the next paint.
   */
  revealRow(row: number): boolean;
};

/** Local selection state kept separate from trace rendering concerns. */
export type TraceSelectionDraft = {
  anchor: TraceTextAnchor;
  position: { x: number; y: number };
  mode: "affordance" | "composer";
};

/** Highlight resolution for exact passage or whole-row fallback rendering. */
export type TraceTextHighlight =
  | { kind: "exact"; startOffset: number; endOffset: number }
  | { kind: "row" };
