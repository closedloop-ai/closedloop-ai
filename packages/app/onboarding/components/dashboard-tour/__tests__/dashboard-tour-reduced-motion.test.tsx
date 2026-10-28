/**
 * ISS-8351 / PLN-1875 Step 4: what the tour stops doing when the OS asks for
 * reduced motion — the smooth scroll to the anchor, the spotlight's travel
 * transition, the callout's entrance animation, the progress dots' width and
 * colour transition, and the fly-into-the-dock-button skip animation — plus the
 * once-only guarantee the immediate skip path shares with the animated one.
 *
 * Each motion case asserts BOTH directions off the same fixture, because a
 * suite that only pins the reduced side passes just as well on a tour that
 * never animated.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTourAnchor } from "../../../../insights/components/overview/dashboard-tour-anchors";
import { Tour } from "../dashboard-tour";
import type { TourStep } from "../dashboard-tour-types";
import {
  mountAnchor,
  mountSkipTargetButton,
  overlayLayer,
  progressDots,
  restoreTourDom,
  SKIP_ANIMATION_MS,
  stubScrollTo,
} from "./dashboard-tour.test-helpers";

const SPOTLIGHT_STEP: TourStep = {
  sel: DashboardTourAnchor.Prs,
  eyebrow: "Throughput",
  title: "Shipping velocity",
  body: "Spotlight body.",
};

/** A second step so the dot assertions cover an inactive dot as well as the current one. */
const FOLLOWING_STEP: TourStep = {
  sel: DashboardTourAnchor.Models,
  eyebrow: "Models",
  title: "Models in use",
  body: "Following body.",
};

function preferReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  }));
}

function scrollBehavior(): ScrollBehavior | undefined {
  const scrollTo = Element.prototype.scrollTo as unknown as ReturnType<
    typeof vi.fn
  >;
  const options = scrollTo.mock.calls.at(0)?.at(0) as
    | ScrollToOptions
    | undefined;
  return options?.behavior;
}

beforeEach(() => {
  vi.useFakeTimers();
  stubScrollTo();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreTourDom();
});

describe("Tour under prefers-reduced-motion", () => {
  it("jumps the anchor into view instead of scrolling smoothly to it", () => {
    preferReducedMotion(true);
    mountAnchor(DashboardTourAnchor.Prs);

    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(scrollBehavior()).toBe("auto");
  });

  it("scrolls smoothly when the preference is not set", () => {
    preferReducedMotion(false);
    mountAnchor(DashboardTourAnchor.Prs);

    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(scrollBehavior()).toBe("smooth");
  });

  it("drops the spotlight's travel transition", () => {
    preferReducedMotion(true);
    mountAnchor(DashboardTourAnchor.Prs);

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(overlayLayer(container).style.transition).toBe("none");
  });

  it("keeps the spotlight travelling when the preference is not set", () => {
    preferReducedMotion(false);
    mountAnchor(DashboardTourAnchor.Prs);

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(overlayLayer(container).style.transition).not.toBe("none");
  });

  it("drops the callout's entrance animation", () => {
    preferReducedMotion(true);
    mountAnchor(DashboardTourAnchor.Prs);

    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(screen.getByRole("dialog").style.animation).toBe("none");
  });

  it("keeps the callout rising in when the preference is not set", () => {
    preferReducedMotion(false);
    mountAnchor(DashboardTourAnchor.Prs);

    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(screen.getByRole("dialog").style.animation).not.toBe("none");
  });

  it("drops the width and colour transition on every progress dot", () => {
    preferReducedMotion(true);
    mountAnchor(DashboardTourAnchor.Prs);

    render(
      <Tour
        active
        onClose={vi.fn()}
        resolveSteps={() => [SPOTLIGHT_STEP, FOLLOWING_STEP]}
      />
    );

    const dots = progressDots(screen.getByRole("dialog"));
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.style.transition).toBe("none");
    }
  });

  it("keeps the progress dots transitioning when the preference is not set", () => {
    preferReducedMotion(false);
    mountAnchor(DashboardTourAnchor.Prs);

    render(
      <Tour
        active
        onClose={vi.fn()}
        resolveSteps={() => [SPOTLIGHT_STEP, FOLLOWING_STEP]}
      />
    );

    const dots = progressDots(screen.getByRole("dialog"));
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.style.transition).not.toBe("none");
    }
  });

  it("closes on skip at once rather than flying into the dock button", () => {
    preferReducedMotion(true);
    mountSkipTargetButton();
    const onClose = vi.fn();

    render(
      <Tour active onClose={onClose} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );
    // The footer control, not the full-viewport click blocker that shares its
    // accessible name.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Skip tour" })[1] as HTMLElement
    );

    // No timer advanced: the animation path would still be mid-flight here.
    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("still waits for the animation when the preference is not set", () => {
    preferReducedMotion(false);
    mountSkipTargetButton();
    const onClose = vi.fn();

    render(
      <Tour active onClose={onClose} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Skip tour" })[1] as HTMLElement
    );

    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SKIP_ANIMATION_MS);
    expect(onClose).toHaveBeenCalledWith("skip");
  });

  // The animated path is latched by the `skip` state, and
  // dashboard-tour-modes.test.tsx pins it there. The immediate path never sets
  // that state, so before the shared `skipping` ref every trigger on it —
  // Escape, the blocker, the footer button — fired `onClose("skip")` again.
  it("fires onClose once however many times the immediate skip is triggered", () => {
    preferReducedMotion(true);
    mountSkipTargetButton();
    const onClose = vi.fn();

    render(
      <Tour active onClose={onClose} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Skip tour" })[1] as HTMLElement
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
