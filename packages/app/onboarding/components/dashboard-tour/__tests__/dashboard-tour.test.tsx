/**
 * ISS-5112 (PLN-1600 Step C): the last step's primary button has to say what
 * pressing it does. It closed the tour and nothing else until guest mode started
 * handing the last step off to the account dialog, at which point "Done"
 * describes the wrong thing.
 *
 * Moved here with the engine (ISS-8351 / PLN-1875 Step 2); it was
 * `apps/desktop/.../dashboard/tour/__tests__/tour.test.tsx`.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DashboardTourAnchor } from "../../../../insights/components/overview/dashboard-tour-anchors";
import { Tour } from "../dashboard-tour";
import type { TourStep } from "../dashboard-tour-types";
import { progressDots } from "./dashboard-tour.test-helpers";

/** What `Tour` refuses an unresolved run with. */
const EMPTY_RUN_LIST = /empty run list/;
/** The callout's advance control, which is named "Next" on any non-final step. */
const NEXT_BUTTON = /Next/;
/** The last step's primary button when finishing only closes the tour. */
const DONE_BUTTON_NAME = "Done";

const STEPS: TourStep[] = [
  {
    sel: DashboardTourAnchor.Stats,
    eyebrow: "Your numbers",
    title: "Start with the headline metrics",
    body: "First step body.",
  },
  {
    sel: DashboardTourAnchor.Prs,
    eyebrow: "Throughput",
    title: "Shipping velocity",
    body: "Last step body.",
  },
];

/** Mount the tour and advance a step, so the last step is on screen. */
function renderTourAtLastStep(completeLabel?: string) {
  const onClose = vi.fn();
  render(
    <Tour
      active
      completeLabel={completeLabel}
      onClose={onClose}
      resolveSteps={() => STEPS}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
  return onClose;
}

describe("Tour — the last step's primary button (ISS-5112)", () => {
  it("says 'Done' when finishing the tour only closes it", () => {
    renderTourAtLastStep();

    expect(
      screen.getByRole("button", { name: DONE_BUTTON_NAME })
    ).toBeDefined();
  });

  it("says what happens next when the caller hands the ending off", () => {
    renderTourAtLastStep("Create account");

    expect(
      screen.getByRole("button", { name: "Create account" })
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: DONE_BUTTON_NAME })).toBeNull();
  });

  it("keeps the step set a run started with when it changes underneath", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Tour active onClose={onClose} resolveSteps={() => STEPS} />
    );
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    expect(
      screen.getByRole("button", { name: DONE_BUTTON_NAME })
    ).toBeDefined();

    // A caller's list is rebuilt from live data — the dashboard's rows arrive
    // on a staggered reveal, so a re-measure mid-run can return a SHORTER set.
    // Unfrozen, `idx` then pointed past the new end — the
    // step went undefined, this component returned null, and the tour vanished
    // without ever calling `onClose`, so the tour-seen flag was never written
    // and the host still believed the tour was open.
    rerender(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [STEPS[0] as TourStep]}
      />
    );

    expect(
      screen.getByRole("button", { name: DONE_BUTTON_NAME })
    ).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("adopts a rebuilt step set on the next activation", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Tour active={false} onClose={onClose} resolveSteps={() => STEPS} />
    );

    // Freezing must not mean stale: `replayTour` toggles `active` off and back
    // on, which is when a run picks up whatever the current set is.
    rerender(
      <Tour
        active
        onClose={onClose}
        resolveSteps={() => [STEPS[0] as TourStep]}
      />
    );
    // The rebuilt set is ONE step, so its only step is also its last and the
    // primary button completes rather than advances. That is the assertion:
    // a run that had stayed frozen on the two-step set would offer "Next" here
    // and never reach `onClose`.
    fireEvent.click(screen.getByRole("button", { name: DONE_BUTTON_NAME }));

    expect(onClose).toHaveBeenCalledWith("done");
  });

  it("still reports a completed tour under the handoff label", () => {
    const onClose = renderTourAtLastStep("Create account");

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(onClose).toHaveBeenCalledWith("done");
  });
});

describe("Tour — the frame the run opens on (ISS-8351)", () => {
  it("paints the activation frame from the set it was opened with", () => {
    const committedDots: number[] = [];
    /**
     * Record every frame the tour actually put on screen.
     *
     * A layout effect runs after a commit's DOM is in place and BEFORE the
     * browser paints, so it sees the frames a passive-effect freeze leaves
     * behind — which an assertion after `rerender` cannot, because `act` has
     * already flushed the correction by then.
     */
    function DotProbe() {
      useLayoutEffect(() => {
        committedDots.push(progressDots(document.body).length);
      });
      return null;
    }
    const onClose = vi.fn();
    const tree = (active: boolean, steps: TourStep[]) => (
      <>
        <Tour active={active} onClose={onClose} resolveSteps={() => steps} />
        <DotProbe />
      </>
    );
    // The run is resolved by MEASURING the page, so the run the tour opens with
    // only exists from the activation render onward — before it, the caller can
    // only answer with whatever the page had laid out at mount.
    const { rerender } = render(tree(false, [STEPS[0] as TourStep]));
    committedDots.length = 0;

    rerender(tree(true, STEPS));

    // One frame, already carrying the whole run. Freezing from an effect showed
    // a single dot first, over a step whose primary button was wired to close
    // rather than advance because `idx` was the last index of a one-step list.
    expect(committedDots).toEqual([STEPS.length]);
  });

  it("refuses a run its caller had not resolved by the render that opens it", () => {
    // The shape the freeze used to accept in silence, and the reason the run
    // list is now the tour's to ASK for rather than the caller's to hand over.
    // `LateCaller` is the second-consumer hazard written out: steps that arrive
    // from an effect, one commit after the render that opens the tour. Given a
    // value, the tour froze that empty first render and ran a walkthrough with
    // no steps, never reaching `onClose` — so the host went on believing the
    // tour was open and offered it again on the next visit, with nothing
    // anywhere saying why.
    function LateCaller() {
      const [steps, setSteps] = useState<readonly TourStep[]>([]);
      useEffect(() => setSteps(STEPS), []);
      return <Tour active onClose={vi.fn()} resolveSteps={() => steps} />;
    }

    expect(() => render(<LateCaller />)).toThrow(EMPTY_RUN_LIST);
  });
});

// ISS-12110, Marisol Ashgrove's 2026-10-07 ruling: "go to the next beat once the
// data for that beat is ready".
describe("Tour — the next beat waits for its panel's data (ISS-12110)", () => {
  it("holds Next until the next step's panel is ready, then advances", () => {
    const onClose = vi.fn();
    const tree = (prsReady: boolean) => (
      <Tour
        active
        isStepReady={(anchor) => anchor !== DashboardTourAnchor.Prs || prsReady}
        onClose={onClose}
        resolveSteps={() => STEPS}
      />
    );
    const { rerender } = render(tree(false));
    const next = screen.getByRole("button", {
      name: NEXT_BUTTON,
    });

    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(next);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      STEPS[0]?.title
    );

    rerender(tree(true));

    expect(next.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(next);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      STEPS[1]?.title
    );
  });

  it("asks about the NEXT step, never the one on screen", () => {
    render(
      <Tour
        active
        isStepReady={(anchor) => anchor !== DashboardTourAnchor.Stats}
        onClose={vi.fn()}
        resolveSteps={() => STEPS}
      />
    );

    expect(
      screen
        .getByRole("button", { name: NEXT_BUTTON })
        .getAttribute("aria-disabled")
    ).toBe("false");
  });

  it("never holds the last step's completion control", () => {
    const onClose = vi.fn();
    render(
      <Tour
        active
        isStepReady={() => false}
        onClose={onClose}
        resolveSteps={() => [STEPS[0] as TourStep]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: DONE_BUTTON_NAME }));

    expect(onClose).toHaveBeenCalledWith("done");
  });
});
