/**
 * The nearest ancestor that actually scrolls.
 *
 * Lives in this package because the lowest layer that needs it owns it: a
 * component here cannot reach into `@repo/app` (the boundary is gated), and a
 * component that must observe the scroller it was mounted inside has no prop to
 * read it from — `GridTableV2` documents that the HOST owns the scroll
 * container, which is exactly why it has to find it.
 */

/**
 * The nearest scrolling ancestor of `node`, or `null` when none of its
 * ancestors scrolls.
 *
 * `overflowY: visible | hidden | clip` do not scroll, so they are skipped rather
 * than returned. `null` means "nothing here scrolls" and NOT "the document
 * does": a caller that wants the document scroller has to say so, because the
 * two have different viewport heights and a caller treating one as the other
 * measures a page where it meant to measure a pane.
 */
export function resolveScrollParent(node: Element | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const { overflowY } = globalThis.getComputedStyle(current);
    if (SCROLLING_OVERFLOW_VALUES.has(overflowY)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Computed `overflow-y` values that produce a scroll container. `overlay` is
 * included because it is a legacy alias of `auto` that WebKit still reports.
 */
const SCROLLING_OVERFLOW_VALUES: ReadonlySet<string> = new Set([
  "auto",
  "scroll",
  "overlay",
]);
