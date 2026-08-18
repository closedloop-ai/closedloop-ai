/**
 * jsdom gap-fillers shared by `packages/app` and the Storybook portable-stories
 * sweep (`apps/storybook`).
 *
 * jsdom implements no layout engine and omits several browser APIs that
 * design-system and app-core components mount unconditionally. Each shim below
 * fills one of those gaps. They are pure environment setup — no vitest import,
 * no per-test state — so importing this module is order-independent and safe
 * from a `@vitest-environment node` file (every block is guarded).
 *
 * Extracted (ISS-5287) so the Storybook sweep could reuse these instead of
 * adding a third hand-maintained copy. Behavior is `packages/app`'s version
 * verbatim, which was the more complete of the two that existed.
 *
 * NOT yet consumed by `apps/app`, which still hand-rolls its own `scrollIntoView`
 * and `matchMedia` shims and has never had the pointer-capture or ResizeObserver
 * ones. That copy was left in place deliberately rather than overlooked:
 * introducing a ResizeObserver shim to a suite that has run without one can
 * change existing outcomes (a virtualizer that measured a 0-height viewport and
 * rendered nothing starts rendering rows), and validating that is a bigger job
 * than the extraction it would ride along with. So this module is two of three
 * consumers, not all of them — migrating `apps/app` remains open.
 */

// jsdom does not implement matchMedia, which `useMediaQuery` reads. Components
// behind the responsive-modal hook (the shared confirmation / delete / rename
// dialogs) mount it, so provide a global non-matching stub rather than per test.
// No-match keeps the desktop Dialog path (matching the hook's SSR snapshot); a
// test needing the mobile Sheet path overrides this in its own setup.
if (globalThis.window !== undefined && !globalThis.window.matchMedia) {
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
    writable: true,
  });
}

// Mock scrollIntoView which jsdom does not implement, plus the pointer-capture
// APIs Radix's dismissable layers call and jsdom omits (Popover/Tooltip/Dialog
// would throw otherwise). Guarded for `@vitest-environment node` files where
// Element is undefined.
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

// jsdom has neither ResizeObserver nor layout, so any component that uses a
// virtualizer/observer (e.g. the virtualized session trace) would throw on mount
// and then measure a 0-height viewport (rendering nothing). Provide a shim that
// reports a fixed non-zero size once, so the virtualizer measures a usable
// viewport and renders the short fixtures these tests use. Test infrastructure
// only — production windowing is unconditional.
if (typeof globalThis.ResizeObserver === "undefined") {
  const OBSERVED_WIDTH = 800;
  const OBSERVED_HEIGHT = 600;

  // Fully typed rather than cast into shape: `ResizeObserverEntry` needs
  // contentBoxSize and devicePixelContentBoxSize alongside borderBoxSize, and
  // the repo's no-double-cast gate (FEA-4114) exempts test *files* but not a
  // shared setup module like this one.
  class ResizeObserverShim implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element, _options?: ResizeObserverOptions): void {
      const size: ResizeObserverSize = {
        inlineSize: OBSERVED_WIDTH,
        blockSize: OBSERVED_HEIGHT,
      };
      const entry: ResizeObserverEntry = {
        target,
        contentRect: new DOMRect(0, 0, OBSERVED_WIDTH, OBSERVED_HEIGHT),
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size],
      };
      this.callback([entry], this);
    }

    unobserve(): void {
      // no-op
    }

    disconnect(): void {
      // no-op
    }
  }

  globalThis.ResizeObserver = ResizeObserverShim;
}
