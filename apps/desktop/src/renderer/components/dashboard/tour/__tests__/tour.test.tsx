/**
 * ISS-5112 (PLN-1600 Step C): the last step's primary button has to say what
 * pressing it does. It closed the tour and nothing else until guest mode started
 * handing the last step off to the account dialog, at which point "Done"
 * describes the wrong thing.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tour, type TourStep } from "../tour";

const STEPS: TourStep[] = [
  {
    intro: true,
    eyebrow: "Ready",
    title: "Build and see how your agents perform",
    body: "Intro body.",
    summary: [],
  },
  {
    sel: "prs",
    eyebrow: "Throughput",
    title: "Shipping velocity",
    body: "Last step body.",
  },
];

/** Mount the tour and advance off the intro, so the last step is on screen. */
function renderTourAtLastStep(completeLabel?: string) {
  const onClose = vi.fn();
  render(
    <Tour
      active
      completeLabel={completeLabel}
      onClose={onClose}
      steps={STEPS}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Take a quick tour" }));
  return onClose;
}

describe("Tour — the last step's primary button (ISS-5112)", () => {
  it("says 'Done' when finishing the tour only closes it", () => {
    renderTourAtLastStep();

    expect(screen.getByRole("button", { name: "Done" })).toBeDefined();
  });

  it("says what happens next when the caller hands the ending off", () => {
    renderTourAtLastStep("Create account");

    expect(
      screen.getByRole("button", { name: "Create account" })
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("keeps the step set a run started with when it changes underneath", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Tour active onClose={onClose} steps={STEPS} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Take a quick tour" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeDefined();

    // `steps` is rebuilt from live data: the guest flag can resolve and the
    // harness read can land after the tour is open, and guest mode's set is one
    // step SHORTER. Unfrozen, `idx` then pointed past the new end — the step
    // went undefined, this component returned null, and the tour vanished
    // without ever calling `onClose`, so the tour-seen flag was never written
    // and the host still believed the tour was open.
    rerender(<Tour active onClose={onClose} steps={[STEPS[0] as TourStep]} />);

    expect(screen.getByRole("button", { name: "Done" })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("adopts a rebuilt step set on the next activation", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Tour active={false} onClose={onClose} steps={STEPS} />
    );

    // Freezing must not mean stale: `replayTour` toggles `active` off and back
    // on, which is when a run picks up whatever the current set is.
    rerender(<Tour active onClose={onClose} steps={[STEPS[0] as TourStep]} />);
    fireEvent.click(screen.getByRole("button", { name: "Take a quick tour" }));

    expect(onClose).toHaveBeenCalledWith("done");
  });

  it("still reports a completed tour under the handoff label", () => {
    const onClose = renderTourAtLastStep("Create account");

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(onClose).toHaveBeenCalledWith("done");
  });
});
