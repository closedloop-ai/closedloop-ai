import { useContainerWidth } from "@closedloop-ai/design-system/hooks/use-container-width";
import { render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `vitest.setup.ts` already installs a global `ResizeObserver` shim that
 * reports a fixed 800x600 content box on `observe`. These tests rely on that
 * default for the "real measurement" path and only override the global where
 * the test needs a different box (zero, a border/content-box mismatch, or no
 * observer at all).
 */

const SHIMMED_OBSERVER_WIDTH_PX = 800;
const DEFAULT_CONTAINER_WIDTH_PX = 1024;
const ZERO_CONTAINER_WIDTH_PX = 0;
const PROBE_PADDING_X_PX = 12;

type ObserverCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver
) => void;

function Probe({ style }: { style?: CSSProperties }) {
  const { ref, width, measured } = useContainerWidth<HTMLDivElement>();
  return (
    <div ref={ref} style={style}>
      <span data-testid="width">{width}</span>
      <span data-testid="measured">{String(measured)}</span>
    </div>
  );
}

function ConditionalProbe({
  attached,
  nodeKey,
}: {
  attached: boolean;
  nodeKey?: string;
}) {
  const { ref, width, measured } = useContainerWidth<HTMLDivElement>();
  return (
    <div>
      {attached ? <div key={nodeKey} ref={ref} /> : null}
      <span data-testid="width">{width}</span>
      <span data-testid="measured">{String(measured)}</span>
    </div>
  );
}

function readProbe() {
  return {
    width: Number(screen.getByTestId("width").textContent),
    measured: screen.getByTestId("measured").textContent,
  };
}

/** Report `widthPx` as the observed content-box width for every observer. */
function stubObservedWidthPx(widthPx: number): () => void {
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
            contentRect: { width: widthPx, height: 0 } as DOMRect,
          } as ResizeObserverEntry,
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

type TrackedObserver = {
  notify: (widthPx: number) => void;
  disconnected: boolean;
};

/**
 * Like `stubObservedWidthPx`, but hands back every observer the hook builds so
 * a test can fire one AFTER the hook was supposed to disconnect it.
 *
 * `disconnect` is honored here rather than being a no-op, which is the whole
 * point: a real `ResizeObserver` delivers nothing once disconnected, so a stub
 * that keeps delivering would let the hook pass with its cleanup deleted.
 */
function trackObservedWidthPx(initialWidthPx: number): {
  observers: TrackedObserver[];
  setObservedWidthPx: (widthPx: number) => void;
  restore: () => void;
} {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  const observers: TrackedObserver[] = [];
  let observedWidthPx = initialWidthPx;

  class TrackingResizeObserver {
    private readonly callback: ObserverCallback;
    private readonly entry: TrackedObserver;
    private target: Element | null = null;

    constructor(callback: ObserverCallback) {
      this.callback = callback;
      this.entry = {
        disconnected: false,
        notify: (widthPx: number) => this.deliver(widthPx),
      };
      observers.push(this.entry);
    }

    private deliver(widthPx: number) {
      if (this.entry.disconnected || !this.target) {
        return;
      }
      this.callback(
        [
          {
            target: this.target,
            contentRect: { width: widthPx, height: 0 } as DOMRect,
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver
      );
    }

    observe(target: Element) {
      this.target = target;
      this.deliver(observedWidthPx);
    }
    unobserve() {
      this.target = null;
    }
    disconnect() {
      this.entry.disconnected = true;
    }
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TrackingResizeObserver as unknown as typeof ResizeObserver,
  });

  return {
    observers,
    setObservedWidthPx: (widthPx: number) => {
      observedWidthPx = widthPx;
    },
    restore: () => {
      if (previous) {
        Object.defineProperty(globalThis, "ResizeObserver", previous);
        return;
      }
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
  };
}

/** Remove `ResizeObserver` entirely, so only the synchronous seed can act. */
function removeResizeObserver(): () => void {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Reflect.deleteProperty(globalThis, "ResizeObserver");
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, "ResizeObserver", previous);
    }
  };
}

/** Give every element a fixed BORDER-box width via `getBoundingClientRect`. */
function stubBorderBoxWidthPx(widthPx: number): () => void {
  const previous = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect"
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: () => ({ width: widthPx, height: 0 }) as DOMRect,
  });
  return () => {
    if (previous) {
      Object.defineProperty(
        HTMLElement.prototype,
        "getBoundingClientRect",
        previous
      );
      return;
    }
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  };
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe("useContainerWidth", () => {
  it("reports the observer's measurement as `measured`", () => {
    render(<Probe />);

    expect(readProbe()).toEqual({
      width: SHIMMED_OBSERVER_WIDTH_PX,
      measured: "true",
    });
  });

  it("does not call a zero box a measurement, and holds the wide default instead", () => {
    // A detached container, a `display:none` subtree, or a keep-alive view
    // parked off-screen. A caller picking between layouts on a breakpoint
    // must not read 0 and render its narrow layout for a container that is
    // merely hidden.
    restore = stubObservedWidthPx(ZERO_CONTAINER_WIDTH_PX);

    render(<Probe />);

    expect(readProbe()).toEqual({
      width: DEFAULT_CONTAINER_WIDTH_PX,
      measured: "false",
    });
  });

  it("seeds the CONTENT box synchronously, the same box the observer reports", () => {
    // `getBoundingClientRect().width` is the BORDER box; subtracting padding
    // and border is what makes the synchronous seed agree with the observer's
    // `contentRect.width`. Remove the observer so only the seed can act.
    const restoreRect = stubBorderBoxWidthPx(
      1108 + PROBE_PADDING_X_PX + PROBE_PADDING_X_PX
    );
    const restoreObserver = removeResizeObserver();
    restore = () => {
      restoreObserver();
      restoreRect();
    };

    render(
      <Probe
        style={{
          paddingLeft: PROBE_PADDING_X_PX,
          paddingRight: PROBE_PADDING_X_PX,
        }}
      />
    );

    expect(readProbe()).toEqual({ width: 1108, measured: "true" });
  });

  it("observes a container attached AFTER the first commit", () => {
    // A caller that renders the measured wrapper conditionally attaches the
    // node after mount; a mount-only effect would never observe it.
    const { rerender } = render(<ConditionalProbe attached={false} />);

    expect(readProbe()).toEqual({
      width: DEFAULT_CONTAINER_WIDTH_PX,
      measured: "false",
    });

    rerender(<ConditionalProbe attached />);

    expect(readProbe()).toEqual({
      width: SHIMMED_OBSERVER_WIDTH_PX,
      measured: "true",
    });
  });

  it("re-measures when the observed container is replaced, and the old observer can no longer report", () => {
    const tracked = trackObservedWidthPx(1108);
    restore = tracked.restore;

    const { rerender } = render(<ConditionalProbe attached nodeKey="first" />);
    expect(readProbe()).toEqual({ width: 1108, measured: "true" });
    expect(tracked.observers).toHaveLength(1);

    tracked.setObservedWidthPx(640);
    rerender(<ConditionalProbe attached nodeKey="second" />);

    expect(readProbe()).toEqual({ width: 640, measured: "true" });
    // A SECOND observer was built for the new node, and the first was let go.
    expect(tracked.observers).toHaveLength(2);
    expect(tracked.observers[0]?.disconnected).toBe(true);

    // The stale observer firing late must not overwrite the live measurement.
    // Without the effect's `observer.disconnect()` cleanup the first observer
    // is still live here, delivers 1108, and the width snaps back to the node
    // that is no longer on screen.
    tracked.observers[0]?.notify(1108);

    expect(readProbe()).toEqual({ width: 640, measured: "true" });
  });

  it("stays unmeasured where there is no ResizeObserver at all", () => {
    restore = removeResizeObserver();

    render(<Probe />);

    expect(readProbe()).toEqual({
      width: DEFAULT_CONTAINER_WIDTH_PX,
      measured: "false",
    });
  });
});
