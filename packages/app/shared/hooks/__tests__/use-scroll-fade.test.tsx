import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useScrollFade } from "../use-scroll-fade";

// Drives a real forwarded ref through the hook and surfaces the two fade flags
// as text so the test can assert on scroll-metric-derived state — the path the
// sidebar's mocked SidebarContent (which drops the ref) never exercises.
function Harness({ overflowY = "auto" }: { overflowY?: "auto" | "hidden" }) {
  const { ref, showTopFade, showBottomFade } = useScrollFade();
  return (
    <div data-testid="scroll" ref={ref} style={{ overflowY }}>
      <span data-testid="top">{String(showTopFade)}</span>
      <span data-testid="bottom">{String(showBottomFade)}</span>
    </div>
  );
}

// Horizontal-axis variant. `showTopFade`/`showBottomFade` map to the left/right
// edges of a horizontally scrolling track (the My Tasks filter-category row).
function HorizontalHarness({
  overflowX = "auto",
}: {
  overflowX?: "auto" | "hidden";
}) {
  const { ref, showTopFade, showBottomFade } = useScrollFade("horizontal");
  return (
    <div data-testid="scroll" ref={ref} style={{ overflowX }}>
      <span data-testid="left">{String(showTopFade)}</span>
      <span data-testid="right">{String(showBottomFade)}</span>
    </div>
  );
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

function setHorizontalScrollMetrics(
  element: HTMLElement,
  metrics: { scrollLeft: number; scrollWidth: number; clientWidth: number }
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

function fireScroll(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new Event("scroll"));
  });
}

describe("useScrollFade", () => {
  beforeEach(() => {
    // jsdom lacks ResizeObserver; stub it so the hook's effect can run. Updates
    // are driven explicitly via scroll events below.
    vi.stubGlobal(
      "ResizeObserver",
      class {
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
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows only the bottom fade when scrolled to the top of overflowing content", () => {
    const { getByTestId } = render(<Harness />);
    const element = getByTestId("scroll");
    setScrollMetrics(element, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 200,
    });
    fireScroll(element);

    expect(getByTestId("top").textContent).toBe("false");
    expect(getByTestId("bottom").textContent).toBe("true");
  });

  test("shows the top fade and clears the bottom fade when scrolled to the end", () => {
    const { getByTestId } = render(<Harness />);
    const element = getByTestId("scroll");
    setScrollMetrics(element, {
      scrollTop: 300,
      scrollHeight: 500,
      clientHeight: 200,
    });
    fireScroll(element);

    expect(getByTestId("top").textContent).toBe("true");
    expect(getByTestId("bottom").textContent).toBe("false");
  });

  test("shows both fades when scrolled to the middle", () => {
    const { getByTestId } = render(<Harness />);
    const element = getByTestId("scroll");
    setScrollMetrics(element, {
      scrollTop: 150,
      scrollHeight: 500,
      clientHeight: 200,
    });
    fireScroll(element);

    expect(getByTestId("top").textContent).toBe("true");
    expect(getByTestId("bottom").textContent).toBe("true");
  });

  test("shows no fades when content fits within the viewport", () => {
    const { getByTestId } = render(<Harness />);
    const element = getByTestId("scroll");
    setScrollMetrics(element, {
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 200,
    });
    fireScroll(element);

    expect(getByTestId("top").textContent).toBe("false");
    expect(getByTestId("bottom").textContent).toBe("false");
  });

  test("shows no fades when overflow is clipped even though content exceeds the viewport", () => {
    // Mirrors the icon-collapsed sidebar: overflow:hidden with scrollHeight >
    // clientHeight should not paint a fade on a non-scrollable container.
    const { getByTestId } = render(<Harness overflowY="hidden" />);
    const element = getByTestId("scroll");
    setScrollMetrics(element, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 200,
    });
    fireScroll(element);

    expect(getByTestId("top").textContent).toBe("false");
    expect(getByTestId("bottom").textContent).toBe("false");
  });

  test("horizontal: shows only the right fade when scrolled to the start of an overflowing track", () => {
    const { getByTestId } = render(<HorizontalHarness />);
    const element = getByTestId("scroll");
    setHorizontalScrollMetrics(element, {
      scrollLeft: 0,
      scrollWidth: 500,
      clientWidth: 200,
    });
    fireScroll(element);

    expect(getByTestId("left").textContent).toBe("false");
    expect(getByTestId("right").textContent).toBe("true");
  });

  test("horizontal: shows the left fade and clears the right fade at the end of the track", () => {
    const { getByTestId } = render(<HorizontalHarness />);
    const element = getByTestId("scroll");
    setHorizontalScrollMetrics(element, {
      scrollLeft: 300,
      scrollWidth: 500,
      clientWidth: 200,
    });
    fireScroll(element);

    expect(getByTestId("left").textContent).toBe("true");
    expect(getByTestId("right").textContent).toBe("false");
  });

  test("horizontal: shows no fades when overflowX is clipped even though content exceeds the track", () => {
    const { getByTestId } = render(<HorizontalHarness overflowX="hidden" />);
    const element = getByTestId("scroll");
    setHorizontalScrollMetrics(element, {
      scrollLeft: 0,
      scrollWidth: 500,
      clientWidth: 200,
    });
    fireScroll(element);

    expect(getByTestId("left").textContent).toBe("false");
    expect(getByTestId("right").textContent).toBe("false");
  });
});
