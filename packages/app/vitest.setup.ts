// jest-dom matchers (toBeInTheDocument, toHaveValue, toBeDisabled, etc.) for
// component-render tests co-located in @repo/app slices.
import "@testing-library/jest-dom/vitest";
import "../typescript-config/vitest-localstorage-setup";

// Mock scrollIntoView which is not implemented in jsdom (parity with apps/app's
// setup). Guarded for `@vitest-environment node` files where Element is undefined.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has neither ResizeObserver nor layout, so any component that uses a
// virtualizer/observer (e.g. the virtualized session trace) would throw on mount
// and then measure a 0-height viewport (rendering nothing). Provide a shim that
// reports a fixed non-zero size once, so the virtualizer measures a usable
// viewport and renders the short fixtures these tests use. Test infrastructure
// only — production windowing is unconditional. Guarded for
// `@vitest-environment node` files.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverShim {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: { width: 800, height: 600 },
            borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver
      );
    }
    unobserve() {
      // no-op
    }
    disconnect() {
      // no-op
    }
  }
  globalThis.ResizeObserver =
    ResizeObserverShim as unknown as typeof ResizeObserver;
}
