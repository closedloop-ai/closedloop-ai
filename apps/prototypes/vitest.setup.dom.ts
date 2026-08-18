// jsdom polyfills for the sandbox's opt-in `.test.tsx` (jsdom) tests, mirroring
// packages/app/vitest.setup.ts. Every block is guarded so it is a no-op under
// the default node-environment `.test.ts` files (where Element / window are
// undefined), keeping the node suites dependency-light.

// scrollIntoView + the pointer-capture APIs Radix's dismissable layers call and
// jsdom omits (Popover / Dialog / Tooltip would throw otherwise).
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {
    // no-op
  };
  Element.prototype.releasePointerCapture ??= () => {
    // no-op
  };
}

// jsdom does not implement matchMedia, which the Sidebar's `useIsMobile` reads.
// A non-matching stub keeps the desktop (non-mobile) layout path.
if (globalThis.window !== undefined && !globalThis.window.matchMedia) {
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
    writable: true,
  });
}

// jsdom has neither ResizeObserver nor layout; GridTable's column-fold and Radix
// Popover positioning both construct one and would throw on mount without it. A
// no-op observer is enough for these tests — they assert card/strip text, not
// measured geometry — so nothing needs to report a size.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {
      // no-op
    }
    unobserve() {
      // no-op
    }
    disconnect() {
      // no-op
    }
  };
}
