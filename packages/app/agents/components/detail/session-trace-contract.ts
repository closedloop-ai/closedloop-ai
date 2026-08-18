import type { TraceTextAnchor } from "./trace-comments";

/** Imperative navigation contract shared with trace containers. */
export type SessionTraceHandle = {
  scrollToRow(row: number): void;
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
