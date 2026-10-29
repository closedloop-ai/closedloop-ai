/**
 * The parameterized `ResizeObserver` stub that drives `useContainerWidth`
 * (ISS-7432).
 *
 * jsdom implements no layout engine, so a component that adapts to its own
 * measured container width — the `GridTable` card fallback, the whole-column
 * fold fit, the session timeline's label density — can only be exercised by
 * controlling what `ResizeObserver` reports. Three near-identical shims had
 * accumulated to do that: a parameterized one in `@repo/app`, a fixed 800px one
 * in `vitest-jsdom-setup` beside this file, and a hand-copy in
 * `@repo/design-system`, which exists because that package is gated from
 * importing `@repo/app` at all and the one module both packages already share
 * reported a width no test could vary.
 *
 * This package is the home because BOTH sides may legally import it: they
 * already depend on it and already import `vitest-jsdom-setup` from it by
 * relative path. That relative-import pattern is what this module uses too —
 * `@repo/typescript-config`'s `exports` map lists only the four tsconfig JSON
 * files, so an `exports` entry would be the other option and is not needed for a
 * source module consumed from source.
 *
 * ONE class serves both shapes. A fixed-width stub is the degenerate case of a
 * resizable one — report at `observe`, never change — so the two entry points
 * below differ only in whether the caller is handed a `setWidth`, not in what
 * the observer does. That is the answer to whether `stubResizableContainerWidthPx`
 * follows the fixed stub here: it does, and it removes the reason there were two
 * shapes to keep in step.
 *
 * Entries are fully typed rather than cast into shape. `ResizeObserverEntry`
 * needs `contentBoxSize` and `devicePixelContentBoxSize` alongside
 * `borderBoxSize`, and the repo's no-double-cast gate (FEA-4114) exempts test
 * FILES but not a shared module like this one.
 */

/** The height every stub reports; no consumer measures it, but a zero would
 *  make a virtualizer render nothing. */
const STUB_CONTAINER_HEIGHT_PX = 600;

/**
 * The width `vitest-jsdom-setup` installs process-wide, for suites that need a
 * non-zero viewport rather than a specific one.
 */
export const DEFAULT_STUB_CONTAINER_WIDTH_PX = 800;

type ObserverRegistration = {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  /** The observer the callback is invoked with, so a later `setWidth` can
   *  re-notify without synthesizing a stand-in. */
  observer: ResizeObserver;
};

/** What a test can do to a stub after installing it. */
export type ResizableContainerWidthStub = {
  /** Drive a resize. Call inside `act` so React flushes the state update. */
  setWidth: (widthPx: number) => void;
  /** Put the previous global back exactly as it was. */
  restore: () => void;
};

/**
 * The observer class itself, for a caller that installs it directly and owns the
 * global (`vitest-jsdom-setup`).
 *
 * `registry` is what separates the two shapes. Supplied, every live observer is
 * recorded so a later width change can re-notify all of them — which is what a
 * real `ResizeObserver` does when the window is dragged. Omitted, the observer
 * reports once at `observe` and registers nothing, so a process-wide install
 * accumulates no entries for observers that never disconnect.
 */
export function createContainerWidthObserverShim(
  readWidthPx: () => number,
  registry?: Set<ObserverRegistration>
): typeof ResizeObserver {
  return class ContainerWidthResizeObserver implements ResizeObserver {
    private readonly registration: ObserverRegistration;

    constructor(callback: ResizeObserverCallback) {
      this.registration = {
        callback,
        observer: this,
        targets: new Set<Element>(),
      };
      registry?.add(this.registration);
    }

    // Reports only the target just observed. Re-reporting every earlier target
    // made a hook that observes N cells and re-measures all N per callback cost
    // ~N^3/2 `getComputedStyle` calls (ISS-12047); a real observer delivers an
    // initial entry for the new target alone.
    observe(target: Element, _options?: ResizeObserverOptions): void {
      this.registration.targets.add(target);
      notifyTargets(this.registration, [target], readWidthPx());
    }

    unobserve(target: Element): void {
      this.registration.targets.delete(target);
    }

    disconnect(): void {
      this.registration.targets.clear();
      registry?.delete(this.registration);
    }
  };
}

/**
 * Report `widthPx` as the measured container width for the duration of a test.
 *
 * Call it BEFORE `render`: the hook observes in its mount effect and this shim
 * reports synchronously from `observe`, so the first committed measurement is
 * the width under test. Returns the restore function — call it in `afterEach`
 * (never only at the end of a case, which leaks the stub when an assertion above
 * it throws) so no other suite inherits the stub.
 */
export function stubContainerWidthPx(widthPx: number): () => void {
  return installContainerWidthStub(widthPx).restore;
}

/**
 * Like {@link stubContainerWidthPx}, but the reported width can be CHANGED
 * during the test — the shim keeps every live observer callback and re-notifies
 * them (ISS-4906).
 *
 * Needed because a stub that reports once, at `observe`, can exercise "what does
 * the table render at width W" but never "what does it do WHILE W is changing",
 * which is the whole of the fold-fit damping contract.
 */
export function stubResizableContainerWidthPx(
  initialWidthPx: number
): ResizableContainerWidthStub {
  return installContainerWidthStub(initialWidthPx);
}

function notifyRegistration(
  registration: ObserverRegistration,
  widthPx: number
): void {
  notifyTargets(registration, registration.targets, widthPx);
}

function notifyTargets(
  registration: ObserverRegistration,
  targets: Iterable<Element>,
  widthPx: number
): void {
  for (const target of targets) {
    const size: ResizeObserverSize = {
      inlineSize: widthPx,
      blockSize: STUB_CONTAINER_HEIGHT_PX,
    };
    const entry: ResizeObserverEntry = {
      target,
      contentRect: new DOMRect(0, 0, widthPx, STUB_CONTAINER_HEIGHT_PX),
      borderBoxSize: [size],
      contentBoxSize: [size],
      devicePixelContentBoxSize: [size],
    };
    registration.callback([entry], registration.observer);
  }
}

/**
 * Install the shim over `globalThis.ResizeObserver` and hand back the controls.
 *
 * The restore puts the previous property descriptor back exactly as it was,
 * INCLUDING deleting the property when the environment had no `ResizeObserver`
 * at all — which the desktop renderer suite is.
 */
function installContainerWidthStub(
  initialWidthPx: number
): ResizableContainerWidthStub {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  let currentWidthPx = initialWidthPx;
  // Every observer that has not disconnected, so a width change reaches all of
  // them — a component may observe more than one element.
  const live = new Set<ObserverRegistration>();

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: createContainerWidthObserverShim(() => currentWidthPx, live),
  });

  return {
    setWidth: (widthPx: number) => {
      currentWidthPx = widthPx;
      for (const registration of live) {
        notifyRegistration(registration, currentWidthPx);
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
