/**
 * The two browser APIs `cmdk` mounts unconditionally and jsdom does not
 * implement: it measures its list with `ResizeObserver` and scrolls the
 * selected option into view.
 *
 * One module rather than a copy per palette suite. Restores the captured
 * descriptors so the shared jsdom worker does not inherit the stubs — the
 * repo's global-restoration rule.
 */
class ResizeObserverStub {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}

/** Installs the shims and returns the restore function for `afterEach`. */
export function installPaletteJsdomShims(): () => void {
  const originalResizeObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
    writable: true,
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
    writable: true,
  });

  return () => {
    restoreDescriptor(globalThis, "ResizeObserver", originalResizeObserver);
    restoreDescriptor(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView
    );
  };
}

function restoreDescriptor(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined
) {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}
