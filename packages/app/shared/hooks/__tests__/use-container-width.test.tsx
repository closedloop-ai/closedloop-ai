import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ISS-4889: `measured` is what tells a width-adjusting caller (the `GridTable`
 * fold fit) that the reported width is real rather than the wide pre-measure
 * default. Getting it wrong in either direction is a silent bug — `false`
 * forever means the caller never adapts, `true` on a zero box means it adapts to
 * nothing — and neither shows up in the fold assertions, which only ever run
 * against a measured container. So the contract is pinned here directly.
 *
 * jsdom has no layout, so `getBoundingClientRect` reports zero unless a test
 * stubs it. The observer path runs off `stubContainerWidthPx`; the synchronous
 * seed path is exercised by `stubBorderBoxWidthPx` below, which is what pins
 * that the seed and the observer measure the SAME box.
 */

const ZERO_CONTAINER_WIDTH_PX = 0;

/** The hook's wide pre-measure default, held wherever no real width exists. */
const DEFAULT_CONTAINER_WIDTH_PX = 1024;

/** Horizontal padding on the probe, so its border box exceeds its content box. */
const PROBE_PADDING_X_PX = 12;

function Probe({ style }: { style?: CSSProperties }) {
  const { ref, width, measured } = useContainerWidth<HTMLDivElement>();
  return (
    <div ref={ref} style={style}>
      <span data-testid="width">{width}</span>
      <span data-testid="measured">{String(measured)}</span>
    </div>
  );
}

/**
 * Give every element a fixed BORDER-box width, the box
 * `getBoundingClientRect` reports, and return the restore function. jsdom has
 * no layout engine, so without this the seed reads zero and never fires.
 */
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

/**
 * A probe whose measured wrapper is rendered CONDITIONALLY, mirroring
 * `GridTable`, which only wraps when `cardRender` or `snapFoldToColumns` is on.
 * `nodeKey` forces React to unmount the old node and mount a fresh one, which is
 * how the replacement case is driven.
 */
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

/** Remove `ResizeObserver` so ONLY the synchronous seed can set the width. */
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

function readProbe() {
  return {
    width: Number(screen.getByTestId("width").textContent),
    measured: screen.getByTestId("measured").textContent,
  };
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("useContainerWidth measured contract (ISS-4889)", () => {
  it("reports a real measurement once the container is observed", () => {
    restoreContainerWidth = stubContainerWidthPx(1108);

    render(<Probe />);

    expect(readProbe()).toEqual({ width: 1108, measured: "true" });
  });

  it("does not call a zero box a measurement, and does not report its width either", () => {
    // A detached container, a `display:none` subtree, or a keep-alive view
    // parked off-screen. Adapting a layout to a zero width would be adapting to
    // nothing, so the caller must stay on its unadjusted path.
    //
    // `width` is asserted, not just `measured`: a caller that picks between
    // layouts on a breakpoint rather than adjusting to the exact width reads
    // `width` alone — `GridTable`'s card fallback tests
    // `containerWidth < CARD_FALLBACK_BREAKPOINT` — so reporting 0 here would
    // render the NARROW layout for a container that is merely hidden. The wide
    // default is what the zero-box contract on `DEFAULT_WIDTH` promises.
    restoreContainerWidth = stubContainerWidthPx(ZERO_CONTAINER_WIDTH_PX);

    render(<Probe />);

    expect(readProbe()).toEqual({
      width: DEFAULT_CONTAINER_WIDTH_PX,
      measured: "false",
    });
  });

  it("seeds the CONTENT box, the same box the observer reports, not the border box", () => {
    // The seed and the observer must not hand the caller two different
    // measurements under one name. `getBoundingClientRect().width` is the
    // BORDER box; `entry.contentRect.width` is the CONTENT box. With
    // horizontal padding they disagree, and `GridTable`'s fold fit turns the
    // number straight into rendered geometry — a border-box width would snap
    // the fold to a boundary `padding-x` px inside the real viewport edge,
    // putting a column back across the fold.
    const restoreRect = stubBorderBoxWidthPx(
      1108 + PROBE_PADDING_X_PX + PROBE_PADDING_X_PX
    );
    const restoreObserver = removeResizeObserver();
    restoreContainerWidth = () => {
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

    // 1132px border box − 24px padding = the 1108px content box the observer
    // would have reported for the same element.
    expect(readProbe()).toEqual({ width: 1108, measured: "true" });
  });

  it("observes a container attached AFTER the first commit", () => {
    // GridTable renders its measured wrapper only when `cardRender` or
    // `snapFoldToColumns` is on, so flipping either prop attaches the node after
    // the hook has already mounted. With a mount-only effect the ref was still
    // null when it ran, so no observer was ever created and the width sat at the
    // default forever — snapping would never start.
    restoreContainerWidth = stubContainerWidthPx(1108);

    const { rerender } = render(<ConditionalProbe attached={false} />);

    expect(readProbe()).toEqual({
      width: DEFAULT_CONTAINER_WIDTH_PX,
      measured: "false",
    });

    rerender(<ConditionalProbe attached />);

    expect(readProbe()).toEqual({ width: 1108, measured: "true" });
  });

  it("re-measures when the observed container is replaced by a different node", () => {
    const restoreFirst = stubContainerWidthPx(1108);
    const { rerender } = render(<ConditionalProbe attached nodeKey="first" />);
    expect(readProbe()).toEqual({ width: 1108, measured: "true" });

    // A new node must be observed in its own right, not left reporting the
    // detached one's width.
    restoreFirst();
    restoreContainerWidth = stubContainerWidthPx(640);
    rerender(<ConditionalProbe attached nodeKey="second" />);

    expect(readProbe()).toEqual({ width: 640, measured: "true" });
  });

  it("stays unmeasured where there is no ResizeObserver at all", () => {
    restoreContainerWidth = removeResizeObserver();

    render(<Probe />);

    // The wide default, so a two-layout caller renders its expanded layout
    // rather than flashing the narrow one.
    expect(readProbe()).toEqual({
      width: DEFAULT_CONTAINER_WIDTH_PX,
      measured: "false",
    });
  });
});
