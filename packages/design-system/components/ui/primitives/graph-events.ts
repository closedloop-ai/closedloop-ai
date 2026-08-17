// Cross-cutting signal used to force a `Graph` back to its resting state.
//
// `Graph` owns a bespoke *fixed*-position tooltip div and a set of d3 highlight
// styles (link stroke-opacity/width, node stroke-width) that are cleared only by
// the SVG's own `mouseleave`. When the graph's DOM node is RELOCATED (e.g. a
// widget expanding from a card into a fullscreen modal) — or is moved by a
// keyboard-driven action that never crosses the pointer out of the SVG (hover a
// node, Tab to the expand control, press Enter) — that `mouseleave` never fires,
// so a tooltip opened at the moment of relocation freezes at its old viewport
// coordinates and the hover highlight sticks. The host wrapper that triggers the
// relocation dispatches this document-level event so every mounted `Graph`
// resets itself, mirroring how Radix tooltips are dismissed across the same
// transition. Namespaced to avoid colliding with any third-party event.
export const GRAPH_RESET_EVENT = "ds.graph.reset";

// Dispatch the reset signal so every mounted `Graph` clears its tooltip and
// highlight state. Guarded for SSR (no `document`); safe to call on any widget
// open/close transition.
export function dispatchGraphReset(): void {
  if (globalThis.document === undefined) {
    return;
  }
  globalThis.document.dispatchEvent(new CustomEvent(GRAPH_RESET_EVENT));
}
