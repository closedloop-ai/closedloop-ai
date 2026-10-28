/**
 * DOM fixture shared by the dashboard-tour suites.
 *
 * The suites here mount the same things to exercise the same component — a
 * `data-tour` anchor inside a scrollable parent, the `data-tour-btn` dock target
 * the skip animation flies into — and read back the same untestid-able
 * elements, the overlay layer and the progress dots, off the inline styles the
 * tour gives them. Each lives here rather than as copies that can drift apart.
 */

import { vi } from "vitest";
import { OVERLAY_Z_INDEX } from "../dashboard-tour-geometry";

/** The fly-into-button animation's settle delay before `onClose` fires. */
export const SKIP_ANIMATION_MS = 460;

/** Nodes appended straight to the document, torn down by `restoreTourDom`. */
const mountedNodes: HTMLElement[] = [];

const originalScrollToDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo"
);

/** jsdom does not implement it; the spotlight measure path calls it. */
export function stubScrollTo(): void {
  Element.prototype.scrollTo = vi.fn();
}

/**
 * Undo `stubScrollTo` and remove every node these helpers appended. Restores
 * the original descriptor rather than assigning, so the case where
 * `Element.prototype.scrollTo` never existed leaves no own property behind.
 */
export function restoreTourDom(): void {
  if (originalScrollToDescriptor) {
    Object.defineProperty(
      Element.prototype,
      "scrollTo",
      originalScrollToDescriptor
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollTo");
  }
  for (const node of mountedNodes.splice(0)) {
    node.remove();
  }
}

/**
 * Pin an element's measured box, which jsdom otherwise reports as all zeros.
 *
 * Every consumer of the presence rule needs this, because that rule is
 * `spotlightHole(measureRect(el)) !== null` and jsdom gives every element zero
 * area — so an un-stubbed anchor is ABSENT, and a suite asserting the resolved
 * run list passes for the wrong reason. Shared rather than re-declared per
 * suite (ISS-8351): a second copy is free to drift from the geometry rule it is
 * imitating, and a stub that disagrees with `spotlightHole` makes every test
 * built on it describe a page the product never renders.
 */
export function stubMeasuredSize(
  element: HTMLElement,
  size: { width: number; height: number }
): void {
  element.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      x: 0,
      y: 0,
    }) as DOMRect;
}

/** Mount an anchor the spotlight can measure, inside a scrollable parent. */
export function mountAnchor(sel: string): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const anchor = document.createElement("div");
  anchor.setAttribute("data-tour", sel);
  scroller.append(anchor);
  document.body.append(scroller);
  mountedNodes.push(scroller);
  return anchor;
}

/** Mount the element `startSkip` animates the callout into. */
export function mountSkipTargetButton(): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("data-tour-btn", "");
  document.body.append(button);
  mountedNodes.push(button);
  return button;
}

/** The scrim / spotlight ring layer, found by the z-index the tour parks it on. */
export function overlayLayer(container: HTMLElement): HTMLElement {
  const layer = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
    (element) => element.style.zIndex === String(OVERLAY_Z_INDEX)
  );
  if (!layer) {
    throw new Error("the tour rendered no scrim or spotlight layer");
  }
  return layer;
}

/** Inline style of one progress dot; the engine gives them no test id. */
const DOT_HEIGHT = "6px";
const DOT_RADIUS = "999px";

/**
 * The callout's progress dots, found by the pill geometry the tour gives them.
 *
 * Read back off the inline style, the same way `overlayLayer` finds the scrim by
 * its z-index: the dots carry no test id and no accessible name, so there is
 * nothing else to address them by. The summary card's chips share the pill
 * radius but stand 22px tall, so the height is what separates them.
 *
 * `root` is the caller's: the render container counts every dot on the page,
 * while `screen.getByRole("dialog")` also pins that exactly one callout is open.
 */
export function progressDots(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("span")).filter(
    (span) =>
      span.style.height === DOT_HEIGHT && span.style.borderRadius === DOT_RADIUS
  );
}
