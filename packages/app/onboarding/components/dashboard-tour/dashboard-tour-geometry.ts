/**
 * Spotlight geometry for the dashboard tour.
 *
 * Lifted out of the component so the placement arithmetic is unit-testable
 * without mounting the tour: everything here is a plain function over numbers
 * or a single element, with no React state and no chrome.
 */

import { resolveScrollParent } from "@repo/design-system/lib/scroll-parent";

export type Rect = { top: number; left: number; width: number; height: number };

/** Width of the docked spotlight callout. */
export const CALLOUT_WIDTH = 344;
/** Inset of the docked callout from the bottom-right of the viewport. */
export const DOCK = 24;
/** How far the spotlight hole extends past the anchor on every side. */
export const SPOTLIGHT_PAD = 8;
/**
 * The layer the scrim and the spotlight ring are parked on.
 *
 * Exported because the suites find that layer by reading the z-index back off
 * the rendered node: a second copy of the number in the test helper turns a
 * change here into "the tour rendered no scrim or spotlight layer", which reads
 * as a render failure rather than a stale constant.
 */
export const OVERLAY_Z_INDEX = 61;
/**
 * Headroom left above an anchor scrolled into view, so a sticky header does not
 * cover the element the spotlight is about to ring.
 */
const SCROLL_HEADROOM = 56;

/**
 * The nearest ancestor that actually scrolls, or `null` when the page itself is
 * the scroller.
 *
 * The walk itself moved to `@repo/design-system/lib/scroll-parent` when
 * `GridTableV2`'s windowed body needed it (ISS-12288): a component in that
 * package cannot import this one, so the lower layer owns it and this name stays
 * as the tour's own entry point.
 */
export const getScrollParent = resolveScrollParent;

/** The element's viewport rect, narrowed to the four values the tour uses. */
export function measureRect(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Whether two measurements describe the same box.
 *
 * Carried from the normative prototype, where it guards the same thing it
 * guards here: `measureRect` builds a fresh object on every call, so a watch
 * that re-measures on a steady cadence would hand React a new-by-identity rect
 * four times a second and re-render the tour forever over a box that never
 * moved. Comparing the four numbers is what makes a permanent watch affordable.
 */
export function rectsMatch(a: Rect | null, b: Rect | null): boolean {
  if (!(a && b)) {
    return a === b;
  }
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** The anchor rect grown by `SPOTLIGHT_PAD`, which is the hole the scrim cuts. */
export function spotlightHole(rect: Rect | null): Rect | null {
  // A hole with no area is no hole. A vanished anchor does NOT arrive here as
  // `null`: the measure interval and the resize/scroll listeners keep re-reading
  // the element the effect captured at step entry, and a detached or
  // `display: none` node measures as all zeros. Padding those would cut a 16x16
  // hole at (-8, -8) and light the top-left corner of the viewport under the
  // scrim's `0 0 0 9999px` shadow. Returning null hands the step to the caller's
  // full-dim fallback, which is what a missing anchor was always documented to
  // get.
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    top: rect.top - SPOTLIGHT_PAD,
    left: rect.left - SPOTLIGHT_PAD,
    width: rect.width + SPOTLIGHT_PAD * 2,
    height: rect.height + SPOTLIGHT_PAD * 2,
  };
}

/**
 * Where the scroll container has to land for the anchor to clear the header.
 * Floored at 0 — a target already above the fold would otherwise ask for a
 * negative scroll position.
 */
export function anchorScrollTop({
  containerScrollTop,
  containerTop,
  anchorTop,
}: {
  containerScrollTop: number;
  containerTop: number;
  anchorTop: number;
}): number {
  return Math.max(
    0,
    containerScrollTop + (anchorTop - containerTop) - SCROLL_HEADROOM
  );
}

/**
 * Centre-to-centre offset from the callout to the dock button, which is what
 * the skip animation translates the callout along before it closes.
 */
export function skipTranslation(
  callout: Rect,
  target: Rect
): { dx: number; dy: number } {
  return {
    dx: target.left + target.width / 2 - (callout.left + callout.width / 2),
    dy: target.top + target.height / 2 - (callout.top + callout.height / 2),
  };
}
