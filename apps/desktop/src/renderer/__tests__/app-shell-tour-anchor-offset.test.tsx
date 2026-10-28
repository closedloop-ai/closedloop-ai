/**
 * ISS-11149 — the spotlight follows the analysis bar through the PRODUCTION
 * offset chain, on the shell where that chain actually exists.
 *
 * `packages/app`'s `dashboard-tour-anchor-realignment.test.tsx` proves the tour
 * re-reads its anchor after the settle window and re-places the ring. What it
 * cannot prove, from inside that package, is that anything MOVES the anchor:
 * the production mover is `AnalysisBannerOffsetProvider` carrying the banner's
 * reported height onto `App`'s real `SidebarInset`, and none of that is
 * importable from `packages/app`. So that suite modelled the carry with a local
 * component, and deleting the whole chain left it green (verified: 5/5 pass
 * with `SidebarInset`'s `style` prop removed).
 *
 * This is the missing half, where the provider, the host's reporter, and the
 * inset meet. Everything from the banner's own measurement to the offset landing
 * on the inset is production code; only the PRODUCER of the run is stubbed, and
 * only so a height can be reported without a full onboarding run.
 *
 * The one thing still modelled, and the one thing this runner can never do, is
 * the anchor's own rect: jsdom runs no layout engine, so a `margin-top` on the
 * inset moves no descendant's `getBoundingClientRect`. The anchor's rect is
 * therefore computed FROM the inset's applied margin — a value production wrote,
 * not a number this file picked and not a ref this file keeps. Delete the
 * offset from `App.tsx` and the margin stays empty, the anchor never moves, and
 * the ring stays parked: red.
 */
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import {
  OVERLAY_Z_INDEX,
  SPOTLIGHT_PAD,
} from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-geometry";
import type { TourStep } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-types";
import { OnboardingAnalysisBanner } from "@repo/app/onboarding/components/onboarding-analysis-banner";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnalysisBannerHeightReporter } from "../components/onboarding/analysis-banner-offset";
import {
  ASYNC_SETTLE_TIMEOUT_MS,
  renderDesktopApp,
  setupAppShellSuite,
  TEST_TIMEOUT_MS,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const BAR_HEIGHT_PX = 36;
const SIDEBAR_INSET_SELECTOR = '[data-slot="sidebar-inset"]';
const CONTENT_VIEWPORT_TEST_ID = "desktop-content-viewport";
/** Where the anchor sits before anything offsets the shell beneath the bar. */
const ANCHOR_TOP = 300;
const ANCHOR_WIDTH = 200;
const ANCHOR_HEIGHT = 50;
/**
 * Past the tour's 800ms settle window, so the steady watch is the only thing
 * left that can notice the shift. This establishes a precondition, it does not
 * assert an elapsed duration.
 */
const PAST_SETTLE_MS = 900;

const STEP: TourStep = {
  sel: DashboardTourAnchor.Stats,
  eyebrow: "Your numbers",
  title: "Start with the headline metrics",
  body: "Body.",
};

let reportHeight: ((height: number) => void) | undefined;

vi.mock(
  "../components/onboarding/desktop-guided-onboarding-dialog-host",
  () => ({
    DesktopGuidedOnboardingDialogHost: () => {
      const report = useAnalysisBannerHeightReporter();
      useEffect(() => {
        reportHeight = report;
      }, [report]);
      return (
        <OnboardingAnalysisBanner
          active
          analyzed={2}
          found={5}
          label="Processing agent history"
          onHeightChange={report}
          percent={40}
        />
      );
    },
  })
);

const originalScrollTo = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo"
);

afterEach(() => {
  reportHeight = undefined;
  if (originalScrollTo) {
    Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
    return;
  }
  Reflect.deleteProperty(Element.prototype, "scrollTo");
});

function sidebarInset(): HTMLElement {
  const inset = document.querySelector<HTMLElement>(SIDEBAR_INSET_SELECTOR);
  if (inset === null) {
    throw new Error("shell rendered no sidebar inset");
  }
  return inset;
}

/** The offset production actually applied, read back off the real inset. */
function appliedOffsetPx(): number {
  return Number.parseFloat(sidebarInset().style.marginTop) || 0;
}

/** The spotlight ring's top edge, read off the layer by the z-index it carries. */
function ringTop(container: HTMLElement): string {
  const layer = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
    (element) => element.style.zIndex === String(OVERLAY_Z_INDEX)
  );
  if (!layer) {
    throw new Error("the tour rendered no scrim or spotlight layer");
  }
  return layer.style.top;
}

/**
 * Mount a tour anchor inside the element the shell offsets, reporting a rect
 * that rides the inset's applied margin. Read on every call rather than
 * captured, so a later offset moves the element without re-stubbing.
 */
function mountOffsetAnchor(): void {
  const anchor = document.createElement("div");
  anchor.setAttribute("data-tour", DashboardTourAnchor.Stats);
  anchor.getBoundingClientRect = () => {
    const top = ANCHOR_TOP + appliedOffsetPx();
    return {
      bottom: top + ANCHOR_HEIGHT,
      height: ANCHOR_HEIGHT,
      left: 0,
      right: ANCHOR_WIDTH,
      top,
      width: ANCHOR_WIDTH,
      x: 0,
      y: top,
    } as DOMRect;
  };
  screen.getByTestId(CONTENT_VIEWPORT_TEST_ID).append(anchor);
}

describe("App shell tour anchor across the analysis-bar offset", () => {
  setupAppShellSuite();

  it(
    "re-anchors the spotlight onto the offset the shell applied",
    async () => {
      Element.prototype.scrollTo = vi.fn();
      renderDesktopApp("");
      await waitFor(() => expect(reportHeight).toBeTypeOf("function"), {
        timeout: ASYNC_SETTLE_TIMEOUT_MS,
      });
      mountOffsetAnchor();

      const { container } = render(
        <Tour active onClose={vi.fn()} resolveSteps={() => [STEP]} />
      );

      // Presence on the SAME locator the shifted assertion reads, so a ring
      // that never rendered fails here rather than passing the move silently.
      await waitFor(
        () =>
          expect(ringTop(container)).toBe(`${ANCHOR_TOP - SPOTLIGHT_PAD}px`),
        { timeout: ASYNC_SETTLE_TIMEOUT_MS }
      );
      await new Promise((resolve) => setTimeout(resolve, PAST_SETTLE_MS));

      act(() => reportHeight?.(BAR_HEIGHT_PX));

      // The provider carried the reported height onto the REAL inset...
      expect(sidebarInset().style.marginTop).toBe(`${BAR_HEIGHT_PX}px`);
      // ...and the tour followed the anchor that offset moved.
      await waitFor(
        () =>
          expect(ringTop(container)).toBe(
            `${ANCHOR_TOP + BAR_HEIGHT_PX - SPOTLIGHT_PAD}px`
          ),
        { timeout: ASYNC_SETTLE_TIMEOUT_MS }
      );
    },
    TEST_TIMEOUT_MS
  );
});
