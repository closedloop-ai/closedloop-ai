/**
 * Shared test helper for driving `useContainerWidth` (ISS-4889).
 *
 * jsdom has no layout, so a component that adapts to its own measured container
 * width — the `GridTable` card fallback, and the whole-column fold fit — can only
 * be exercised by controlling what `ResizeObserver` reports. This installs a shim
 * that reports a fixed content-box width to every observer, and returns a restore
 * function that puts the previous global back exactly as it was (including
 * deleting the property when the environment had no `ResizeObserver` at all, as
 * the desktop renderer suite does).
 *
 * Call it BEFORE `render`: the hook observes in its mount effect, and the shim
 * reports synchronously from `observe`, so the first committed measurement is the
 * width under test.
 */

type ObserverCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver
) => void;

const STUB_CONTAINER_HEIGHT_PX = 600;

/**
 * Report `widthPx` as the measured container width for the duration of a test.
 * Returns the restore function — call it in `afterEach` (or immediately after
 * the assertions) so no other suite inherits the stub.
 */
export function stubContainerWidthPx(widthPx: number): () => void {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );

  class StubResizeObserver {
    private readonly callback: ObserverCallback;
    constructor(callback: ObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: {
              width: widthPx,
              height: STUB_CONTAINER_HEIGHT_PX,
            },
            borderBoxSize: [
              { inlineSize: widthPx, blockSize: STUB_CONTAINER_HEIGHT_PX },
            ],
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

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: StubResizeObserver as unknown as typeof ResizeObserver,
  });

  return () => {
    if (previous) {
      Object.defineProperty(globalThis, "ResizeObserver", previous);
      return;
    }
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  };
}

/**
 * Like {@link stubContainerWidthPx}, but the reported width can be CHANGED
 * during the test — the shim keeps every live observer callback and re-notifies
 * them, which is what a real `ResizeObserver` does when the window is dragged
 * (ISS-4906).
 *
 * Needed because the fixed stub above reports once, at `observe`, so it can
 * exercise "what does the table render at width W" but never "what does it do
 * WHILE W is changing" — which is the whole of the fold-fit damping contract.
 *
 * Returns `setWidth` for driving a resize and `restore` to put the previous
 * global back exactly as it was (including deleting the property when the
 * environment had none). Call `setWidth` inside `act` so React flushes the
 * resulting state update.
 */
export function stubResizableContainerWidthPx(initialWidthPx: number): {
  setWidth: (widthPx: number) => void;
  restore: () => void;
} {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  let currentWidth = initialWidthPx;
  // Every observer that has not disconnected, so a width change reaches all of
  // them — a component may observe more than one element.
  const live = new Set<{ callback: ObserverCallback; targets: Set<Element> }>();

  const notify = (entry: {
    callback: ObserverCallback;
    targets: Set<Element>;
  }) => {
    for (const target of entry.targets) {
      entry.callback(
        [
          {
            target,
            contentRect: {
              width: currentWidth,
              height: STUB_CONTAINER_HEIGHT_PX,
            },
            borderBoxSize: [
              { inlineSize: currentWidth, blockSize: STUB_CONTAINER_HEIGHT_PX },
            ],
          } as unknown as ResizeObserverEntry,
        ],
        // The shim never uses the observer argument; callers read the entry.
        null as unknown as ResizeObserver
      );
    }
  };

  class ResizableStubResizeObserver {
    private readonly entry: {
      callback: ObserverCallback;
      targets: Set<Element>;
    };
    constructor(callback: ObserverCallback) {
      this.entry = { callback, targets: new Set<Element>() };
      live.add(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
      notify(this.entry);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
      live.delete(this.entry);
    }
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizableStubResizeObserver as unknown as typeof ResizeObserver,
  });

  return {
    setWidth: (widthPx: number) => {
      currentWidth = widthPx;
      for (const entry of live) {
        notify(entry);
      }
    },
    restore: () => {
      live.clear();
      if (previous) {
        Object.defineProperty(globalThis, "ResizeObserver", previous);
        return;
      }
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
  };
}
