/**
 * ISS-5301: the first-launch tour's three render modes and its exit paths.
 *
 * `dashboard-tour.test.tsx` next door owns the ISS-5112 completion-label
 * contract; this
 * suite covers the rest of the component's behavior, which is where the states
 * a user can actually get stuck live:
 *
 *  - a spotlight step docked to the anchor it rings,
 *  - a spotlight step whose anchor is NOT on screen, which must fall back to a
 *    full-dim scrim rather than unmounting the tour out from under the user,
 *  - the skip paths, including the one where the fly-into-button animation has
 *    no button to fly into and has to close immediately,
 *  - and step navigation, since Back must not be offered on the first step.
 *
 * Every exit asserts `onClose` and its reason: the host writes the tour-seen
 * flag from that callback, so a tour that closes without firing it strands the
 * user in a state that replays forever.
 *
 * Moved here with the engine (ISS-8351 / PLN-1875 Step 2); it was
 * `apps/desktop/.../dashboard/tour/__tests__/tour-modes.test.tsx`.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTourAnchor } from "../../../../insights/components/overview/dashboard-tour-anchors";
import { Tour } from "../dashboard-tour";
import { SPOTLIGHT_PAD } from "../dashboard-tour-geometry";
import type { TourStep } from "../dashboard-tour-types";
import {
  mountAnchor,
  mountSkipTargetButton,
  overlayLayer,
  restoreTourDom,
  SKIP_ANIMATION_MS,
  stubScrollTo,
} from "./dashboard-tour.test-helpers";

/** What `Tour` refuses an unresolved run with. */
const EMPTY_RUN_LIST = /empty run list/;

/** How often the tour re-reads the anchor while a scroll settles. */
const MEASURE_INTERVAL_MS = 50;

const BACK_BUTTON = /Back/;
const NEXT_BUTTON = /Next/;

const SECOND_STEP: TourStep = {
  sel: DashboardTourAnchor.Activity,
  eyebrow: "Activity",
  title: "When the work happens",
  body: "Second body.",
};

const SPOTLIGHT_STEP: TourStep = {
  sel: DashboardTourAnchor.Prs,
  eyebrow: "Throughput",
  title: "Shipping velocity",
  body: "Spotlight body.",
};

/** A spotlight step with no eyebrow, so the `Step N` fallback renders. */
const UNLABELLED_STEP: TourStep = {
  sel: DashboardTourAnchor.Models,
  title: "Spend",
  body: "Cost body.",
};

/**
 * The tour renders TWO controls whose accessible name is "Skip tour": the
 * full-viewport click blocker (`aria-label`) first, then the text button in the
 * callout footer. Address them positionally so neither test is ambiguous.
 */
const SKIP_BLOCKER = 0;
const SKIP_TEXT_BUTTON = 1;

function skipControl(which: number): HTMLElement {
  return screen.getAllByRole("button", { name: "Skip tour" })[
    which
  ] as HTMLElement;
}

/** Pin an anchor's rect so the spotlight has something to measure. */
/**
 * Pin the anchor's measured `top`, modelling the one property of the real DOM
 * the spotlight path depends on: a DETACHED node measures as all zeros. That is
 * how a row unmounting mid-step actually reaches the geometry, and without it a
 * case could `remove()` the node and change nothing this stub reports.
 */
function stubAnchorTop(anchor: HTMLElement, top: () => number): void {
  anchor.getBoundingClientRect = () => {
    if (!anchor.isConnected) {
      return {
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
      } as DOMRect;
    }
    return {
      top: top(),
      left: 0,
      width: 200,
      height: 50,
      right: 200,
      bottom: top() + 50,
      x: 0,
      y: top(),
    } as DOMRect;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  stubScrollTo();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  restoreTourDom();
});

describe("Tour — activation", () => {
  it("renders nothing while inactive", () => {
    const { container } = render(
      <Tour
        active={false}
        onClose={vi.fn()}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("does not resolve a run while the tour is shut", () => {
    // The anchored half is resolved by MEASURING the page, and the rows arrive
    // on a staggered reveal, so a resolve before the tour opens reads a page
    // that is not laid out yet. Nothing renders from it either way; asking is
    // the defect.
    const resolveSteps = vi.fn(() => [SPOTLIGHT_STEP, SECOND_STEP]);

    render(
      <Tour active={false} onClose={vi.fn()} resolveSteps={resolveSteps} />
    );

    expect(resolveSteps).not.toHaveBeenCalled();
  });

  it("resolves once, on the render that opens the run", () => {
    const resolveSteps = vi.fn(() => [SPOTLIGHT_STEP, SECOND_STEP]);
    const { rerender } = render(
      <Tour active={false} onClose={vi.fn()} resolveSteps={resolveSteps} />
    );

    rerender(<Tour active onClose={vi.fn()} resolveSteps={resolveSteps} />);
    const afterActivation = resolveSteps.mock.calls.length;
    rerender(<Tour active onClose={vi.fn()} resolveSteps={resolveSteps} />);

    expect(afterActivation).toBe(1);
    // The freeze: a started run is immutable, so nothing re-asks while it is
    // open. Re-asking would re-measure a page the reader has since scrolled.
    expect(resolveSteps).toHaveBeenCalledTimes(1);
  });

  it("refuses to open a run its caller resolved to nothing", () => {
    expect(() =>
      render(<Tour active onClose={vi.fn()} resolveSteps={() => []} />)
    ).toThrow(EMPTY_RUN_LIST);
  });

  it("renders nothing rather than taking the shell down in production", () => {
    // The refusal above is dev-only. A tour with no steps is a caller bug worth
    // reddening a suite over, and is not worth replacing the whole app with the
    // renderer's root error boundary in front of a user — so production keeps
    // the old degradation.
    vi.stubEnv("NODE_ENV", "production");

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => []} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("reports an empty run over instead of going silent", () => {
    // Rendering nothing is only half of degrading well. A frozen empty run
    // offers the reader no control, so `onClose` would never fire on its own —
    // and a host that tied state to the run keeps holding it: web takes the
    // workspace-experience flow lock for the run's lifetime, so the tree would
    // stay pinned for the rest of the page load behind a tour nobody can see.
    //
    // `empty` rather than `skip` or `done`: the reader did neither, and a host
    // that recorded this run as finished would retire a tour that never painted.
    vi.stubEnv("NODE_ENV", "production");
    const onClose = vi.fn();

    render(<Tour active onClose={onClose} resolveSteps={() => []} />);

    expect(onClose.mock.calls).toEqual([["empty"]]);
  });

  it("says nothing about a run that is merely shut", () => {
    // The guard is `active && empty`, not `empty`. A tour that was never opened
    // has an empty frozen list too, and reporting a close for it would end a run
    // its host never started.
    vi.stubEnv("NODE_ENV", "production");
    const onClose = vi.fn();

    render(<Tour active={false} onClose={onClose} resolveSteps={() => []} />);

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Tour — spotlight steps", () => {
  it("uses the step's own eyebrow when it has one", () => {
    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(screen.getByText("Throughput")).toBeTruthy();
  });

  it("falls back to a positional label when the step has no eyebrow", () => {
    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [UNLABELLED_STEP]} />
    );

    expect(screen.getByText("Step 1")).toBeTruthy();
  });

  it("scrolls a measurable anchor into view and keeps the callout readable", () => {
    mountAnchor("prs");

    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(Element.prototype.scrollTo).toHaveBeenCalled();
    expect(screen.getByText("Shipping velocity")).toBeTruthy();
  });

  it("still shows the step when its anchor is not on screen", () => {
    // No `[data-tour="prs"]` in the document: the tour must fall back to the
    // dimmed scrim + docked callout rather than vanishing mid-run.
    render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );

    expect(screen.getByText("Shipping velocity")).toBeTruthy();
    expect(screen.getByText("Spotlight body.")).toBeTruthy();
  });

  it("follows an anchor that moves after the scroll was asked for", () => {
    // The analysis status bar resolves and reflows the page AFTER the tour has
    // already measured and asked for its scroll. Only the re-measure catches
    // that, and without it the ring is left outlining empty space.
    const anchor = mountAnchor("prs");
    let anchorTop = 100;
    stubAnchorTop(anchor, () => anchorTop);

    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );
    expect(overlayLayer(container).style.top).toBe(`${100 - SPOTLIGHT_PAD}px`);

    anchorTop = 420;
    act(() => {
      vi.advanceTimersByTime(MEASURE_INTERVAL_MS);
    });

    expect(overlayLayer(container).style.top).toBe(`${420 - SPOTLIGHT_PAD}px`);
  });

  it("falls back to the full-dim scrim when its anchor disappears mid-tour", () => {
    const anchor = mountAnchor("prs");
    stubAnchorTop(anchor, () => 100);
    const { container } = render(
      <Tour active onClose={vi.fn()} resolveSteps={() => [SPOTLIGHT_STEP]} />
    );
    const dialog = screen.getByRole("dialog", { name: "Shipping velocity" });
    expect(document.activeElement).toBe(dialog);
    expect(overlayLayer(container).style.top).toBe(`${100 - SPOTLIGHT_PAD}px`);

    // A gated row can unmount while its step is open. The step's `querySelector`
    // already ran, so the detached node stays the one being measured and now
    // reports 0x0 — which must read as "no hole" and dim the whole viewport. Pad
    // it instead and the ring lands on a 16x16 patch of the top-left corner,
    // nowhere near the element that is gone. The scrim branch sets no `top`.
    anchor.remove();
    act(() => {
      vi.advanceTimersByTime(MEASURE_INTERVAL_MS);
    });

    expect(overlayLayer(container).style.top).toBe("");
    // …and the tour holds its step and its focus rather than unmounting the
    // callout out from under the reader.
    expect(screen.getByText("Spotlight body.")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
  });
});

describe("Tour — stepping through", () => {
  it("offers no Back on the first step", () => {
    render(
      <Tour
        active
        onClose={vi.fn()}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();
  });

  it("advances to the next step and back again", () => {
    render(
      <Tour
        active
        onClose={vi.fn()}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    expect(screen.getByText("When the work happens")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: BACK_BUTTON }));
    expect(screen.getByText("Shipping velocity")).toBeTruthy();
  });

  it("shows Next on a middle step and completes from the last one", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP, UNLABELLED_STEP]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    expect(screen.getByText("Spend")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledWith("done");
  });
});

describe("Tour — skipping", () => {
  it("closes immediately when there is no button to animate into", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("waits for the fly-into-button animation before closing", () => {
    mountSkipTargetButton();
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SKIP_ANIMATION_MS);
    });

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("ignores a second skip while the animation is already running", () => {
    mountSkipTargetButton();
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));
    fireEvent.click(skipControl(SKIP_TEXT_BUTTON));
    act(() => {
      vi.advanceTimersByTime(SKIP_ANIMATION_MS);
    });

    // One armed animation, so one close — not two.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips when the dimmed area behind the callout is clicked", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.click(skipControl(SKIP_BLOCKER));

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("dismisses on Escape from inside the callout", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.keyDown(
      screen.getByRole("dialog", {
        name: "Shipping velocity",
      }),
      { key: "Escape" }
    );

    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("leaves other keys alone", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [SPOTLIGHT_STEP, SECOND_STEP]}
      />
    );

    fireEvent.keyDown(
      screen.getByRole("dialog", {
        name: "Shipping velocity",
      }),
      { key: "Enter" }
    );

    expect(onClose).not.toHaveBeenCalled();
  });
});
