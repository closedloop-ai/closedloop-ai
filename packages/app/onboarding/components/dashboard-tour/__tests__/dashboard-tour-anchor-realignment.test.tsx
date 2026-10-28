/**
 * ISS-10546: the spotlight stays on its target across an analysis status-bar
 * layout shift.
 *
 * The normative prototype carries this as an in-UI design note
 * (`packages/app/shell/v2/components/web-master-preview/components/dashboard-spotlight-tour.tsx`):
 * "keep this spotlight anchored through analysis status-bar layout shifts and
 * cover that alignment with VQA or an end-to-end test".
 *
 * WHAT THIS SUITE DOES AND DOES NOT PROVE. The first two cases pin that the
 * watch re-reads the anchor and re-places the ring after the settle window has
 * closed, driven by a stubbed rect that MODELS the shift. The third drives the
 * REAL `OnboardingAnalysisBanner` instead: it mounts beside the tour, arrives
 * mid-step, and the distance the anchor moves is the height the banner itself
 * reports through `onHeightChange`, not a constant this file picked.
 *
 * What stays modelled there, and cannot stop being modelled in this runner, is
 * the anchor's own rect: jsdom runs no layout engine, so a `fixed top-0` banner
 * moves nothing on its own and the offset every host applies beneath it has to
 * be applied here by hand. The end-to-end geometry is the design note's VQA
 * pass, not a unit test.
 *
 * (The earlier caveat here said the banner "has zero production mounts on `main`
 * today". `guided-onboarding-dialog-host.tsx` mounts it on both shells, so that
 * stopped being true and is corrected rather than kept — ISS-11149 row 3.)
 *
 * WHAT ACTUALLY BREAKS, and why neither listener catches it.
 * `OnboardingAnalysisBanner` is `fixed top-0` and its host offsets the shell
 * beneath it by the height the banner reports. So the banner arriving or
 * leaving MOVES every anchor on the page vertically — while changing no window
 * dimension (so `resize` never fires) and scrolling nothing (so `scroll` never
 * fires). The settle interval is the only thing that ever caught it, and that
 * one stops 800ms after the step is entered, whereas analysis finishes whenever
 * it finishes. Past that window the ring stayed parked at its stale rect for
 * the rest of the step, off target by the banner's height.
 *
 * Each case advances the clock PAST `MEASURE_WINDOW_MS` before shifting the
 * anchor, which is the whole point: a case that shifted it inside the settle
 * window passes on the old code and proves nothing.
 */

import { act, render } from "@testing-library/react";
import { useCallback, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTourAnchor } from "../../../../insights/components/overview/dashboard-tour-anchors";
import { OnboardingAnalysisBanner } from "../../onboarding-analysis-banner";
import { Tour } from "../dashboard-tour";
import { SPOTLIGHT_PAD } from "../dashboard-tour-geometry";
import type { TourStep } from "../dashboard-tour-types";
import {
  mountAnchor,
  overlayLayer,
  restoreTourDom,
  stubScrollTo,
} from "./dashboard-tour.test-helpers";

/** The settle interval's cadence and the window it runs for. */
const MEASURE_WINDOW_MS = 800;
/** The steady re-anchor cadence held for the life of the step. */
const ANCHOR_WATCH_INTERVAL_MS = 250;
/** Comfortably past the settle window, so only the steady watch is left. */
const PAST_SETTLE_MS = MEASURE_WINDOW_MS + ANCHOR_WATCH_INTERVAL_MS;

/** A plausible reported height for the analysis banner. */
const BANNER_HEIGHT = 44;
/** What the real banner's own surface measures, once jsdom is given a height. */
const BANNER_SURFACE_HEIGHT = 52;
const ANCHOR_TOP = 300;
const ANCHOR_WIDTH = 200;
const ANCHOR_HEIGHT = 50;

const STEP: TourStep = {
  sel: DashboardTourAnchor.Stats,
  eyebrow: "Your numbers",
  title: "Start with the headline metrics",
  body: "Body.",
};

/**
 * Pin an anchor's rect to a `top` the case can move, modelling the ONE thing
 * the banner actually does to the page: it shifts the anchor vertically and
 * changes nothing else. Reading `top()` on every call rather than capturing it
 * is what lets a case move the element without re-stubbing.
 */
function stubMovableAnchor(anchor: HTMLElement, top: () => number): void {
  anchor.getBoundingClientRect = () =>
    ({
      top: top(),
      left: 0,
      width: ANCHOR_WIDTH,
      height: ANCHOR_HEIGHT,
      right: ANCHOR_WIDTH,
      bottom: top() + ANCHOR_HEIGHT,
      x: 0,
      y: top(),
    }) as DOMRect;
}

/** The spotlight ring's top edge, read back off the rendered layer. */
function ringTop(container: HTMLElement): string {
  return overlayLayer(container).style.top;
}

beforeEach(() => {
  vi.useFakeTimers();
  stubScrollTo();
});

// Unconditional, not the last line of the case that installs it: three
// assertions sit between install and restore, and an assertion throwing there —
// the whole point of the case — would otherwise leave every element in the
// worker reporting a stubbed rect.
let restoreSurfaceHeight: (() => void) | null = null;

afterEach(() => {
  vi.useRealTimers();
  restoreTourDom();
  restoreSurfaceHeight?.();
  restoreSurfaceHeight = null;
});

describe("Tour — spotlight alignment across analysis layout shift", () => {
  it("re-anchors after the settle window has already closed", () => {
    const anchor = mountAnchor(DashboardTourAnchor.Stats);
    let top = ANCHOR_TOP;
    stubMovableAnchor(anchor, () => top);

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [STEP]} />
    );

    act(() => {
      vi.advanceTimersByTime(PAST_SETTLE_MS);
    });
    expect(ringTop(container)).toBe(`${ANCHOR_TOP - SPOTLIGHT_PAD}px`);

    // The banner leaves: the shell's offset collapses and every anchor rides up
    // by the height it had been reporting. No resize, no scroll.
    top = ANCHOR_TOP - BANNER_HEIGHT;
    act(() => {
      vi.advanceTimersByTime(ANCHOR_WATCH_INTERVAL_MS);
    });

    expect(ringTop(container)).toBe(
      `${ANCHOR_TOP - BANNER_HEIGHT - SPOTLIGHT_PAD}px`
    );
  });

  it("re-anchors when the banner arrives and pushes the page down", () => {
    const anchor = mountAnchor(DashboardTourAnchor.Stats);
    let top = ANCHOR_TOP;
    stubMovableAnchor(anchor, () => top);

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [STEP]} />
    );

    act(() => {
      vi.advanceTimersByTime(PAST_SETTLE_MS);
    });

    top = ANCHOR_TOP + BANNER_HEIGHT;
    act(() => {
      vi.advanceTimersByTime(ANCHOR_WATCH_INTERVAL_MS);
    });

    expect(ringTop(container)).toBe(
      `${ANCHOR_TOP + BANNER_HEIGHT - SPOTLIGHT_PAD}px`
    );
  });

  it("keeps re-anchoring for as long as the step is open", () => {
    // Analysis can shift the page more than once — the banner appears, updates
    // its reported height as counts arrive, then leaves. A watch that fired
    // once and latched would hold the second shift's stale rect.
    const anchor = mountAnchor(DashboardTourAnchor.Stats);
    let top = ANCHOR_TOP;
    stubMovableAnchor(anchor, () => top);

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [STEP]} />
    );

    act(() => {
      vi.advanceTimersByTime(PAST_SETTLE_MS);
    });

    for (const shift of [BANNER_HEIGHT, BANNER_HEIGHT * 2, 0]) {
      top = ANCHOR_TOP + shift;
      act(() => {
        vi.advanceTimersByTime(ANCHOR_WATCH_INTERVAL_MS);
      });
      expect(ringTop(container)).toBe(
        `${ANCHOR_TOP + shift - SPOTLIGHT_PAD}px`
      );
    }
  });

  it("stops watching once the tour closes", () => {
    // The watch has no self-imposed end, so its only bound is the effect's
    // cleanup. A leaked interval would keep measuring a detached element for
    // the life of the page.
    const anchor = mountAnchor(DashboardTourAnchor.Stats);
    stubMovableAnchor(anchor, () => ANCHOR_TOP);
    const clearInterval = vi.spyOn(globalThis, "clearInterval");

    const { rerender } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [STEP]} />
    );
    act(() => {
      vi.advanceTimersByTime(PAST_SETTLE_MS);
    });
    clearInterval.mockClear();

    rerender(
      <Tour active={false} onClose={vi.fn()} resolveSteps={() => [STEP]} />
    );

    // Both timers are cleared on teardown: the settle interval and the watch.
    expect(clearInterval).toHaveBeenCalledTimes(2);
    clearInterval.mockRestore();
  });

  it("re-anchors across the real analysis banner arriving mid-step", () => {
    // The banner itself, not a stand-in: it mounts beside the tour, arrives
    // after the settle window, and the distance the anchor travels is the height
    // IT reported. A shift magnitude this file invented could agree with a
    // re-anchor that read the wrong element.
    restoreSurfaceHeight = stubSurfaceHeight(BANNER_SURFACE_HEIGHT);
    const anchor = mountAnchor(DashboardTourAnchor.Stats);
    const offset = { current: 0 };
    stubMovableAnchor(anchor, () => ANCHOR_TOP + offset.current);

    const { container, rerender } = render(
      <BannerBesideTour active={false} offset={offset} />
    );
    act(() => {
      vi.advanceTimersByTime(PAST_SETTLE_MS);
    });
    expect(ringTop(container)).toBe(`${ANCHOR_TOP - SPOTLIGHT_PAD}px`);

    act(() => {
      rerender(<BannerBesideTour active offset={offset} />);
    });
    // The banner measured itself and the host offset the content beneath it.
    expect(offset.current).toBe(BANNER_SURFACE_HEIGHT);

    act(() => {
      vi.advanceTimersByTime(ANCHOR_WATCH_INTERVAL_MS);
    });

    expect(ringTop(container)).toBe(
      `${ANCHOR_TOP + BANNER_SURFACE_HEIGHT - SPOTLIGHT_PAD}px`
    );
  });
});

/**
 * The production pairing: a `fixed top-0` analysis banner and the tour over the
 * same page, with the banner's reported height offsetting everything beneath it.
 *
 * `report` is memoised because the banner's own contract requires it — an
 * identity that changes every render re-arms its measuring effect every render.
 */
function BannerBesideTour({
  active,
  offset,
}: {
  active: boolean;
  offset: { current: number };
}) {
  const [height, setHeight] = useState(0);
  const report = useCallback((next: number) => setHeight(next), []);
  useEffect(() => {
    offset.current = height;
  }, [height, offset]);

  return (
    <>
      <OnboardingAnalysisBanner
        active={active}
        analyzed={12}
        found={40}
        onHeightChange={report}
        percent={30}
      />
      <Tour active onClose={vi.fn()} resolveSteps={() => [STEP]} />
    </>
  );
}

/**
 * Give jsdom a height for elements measured through the prototype. The anchor
 * carries its own instance override, which still wins, so this reaches the
 * banner's surface without touching the rect under test. The caller assigns the
 * returned undo to `restoreSurfaceHeight`, which the block's `afterEach` runs.
 */
function stubSurfaceHeight(height: number): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function stubbed() {
    return { ...EMPTY_RECT, bottom: height, height } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

const EMPTY_RECT = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
  x: 0,
  y: 0,
};
