import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { startupProgressBarName } from "../startup-readiness-progress";
import { StartupReadinessProgressBar } from "../startup-readiness-progress-bar";
import { StartupReadinessPhase } from "../startup-readiness-state";

const INDETERMINATE_CASES = [
  [StartupReadinessPhase.OpeningStore, "Opening the local store"],
  [StartupReadinessPhase.CheckingHistory, "Checking local history"],
  [StartupReadinessPhase.ProcessingHistory, "Processing local history"],
  [StartupReadinessPhase.SyncingCloud, "Syncing cloud history"],
  [StartupReadinessPhase.NeedsAttention, "Startup needs attention"],
] as const;

const SWEEP_CLASS = "motion-safe:animate-progress-indeterminate";
const SHEEN_SELECTOR = '[data-slot="progress-sheen"]';

function renderBar(
  phase: StartupReadinessPhase,
  { paused = false, stage }: { paused?: boolean; stage: string }
) {
  render(<StartupReadinessProgressBar paused={paused} phase={phase} />);
  // Queried by the composed NAME: that is the channel the stage actually
  // travels on, so a regression that drops it fails every case here.
  return screen.getByRole("progressbar", {
    name: startupProgressBarName(stage),
  });
}

function indicatorOf(bar: HTMLElement): HTMLElement {
  const indicator = bar.querySelector<HTMLElement>(
    '[data-slot="progress-indicator"]'
  );
  if (indicator === null) {
    throw new Error("progress bar rendered without an indicator");
  }
  return indicator;
}

describe("StartupReadinessProgressBar", () => {
  afterEach(cleanup);

  it.each(
    INDETERMINATE_CASES
  )("announces %s without claiming a completion value", (phase, valueText) => {
    const bar = renderBar(phase, { stage: valueText });

    // The honesty contract: an indeterminate bar must not emit
    // `aria-valuenow`, or it asserts a percentage the readiness model cannot
    // support — nor `aria-valuetext`, which ARIA only defines alongside it. The
    // `renderBar` lookup already proves the stage rides in the accessible name.
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("aria-valuetext")).toBe(false);
    expect(bar.getAttribute("data-state")).toBe("indeterminate");
  });

  it("reports a determinate 100 only once startup is complete", () => {
    const bar = renderBar(StartupReadinessPhase.Ready, {
      stage: "Startup complete",
    });

    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("data-state")).toBe("complete");
  });

  it("sweeps a sheen while work is in flight, but only under motion-safe", () => {
    const bar = renderBar(StartupReadinessPhase.ProcessingHistory, {
      stage: "Processing local history",
    });
    const sheen = bar.querySelector<HTMLElement>(SHEEN_SELECTOR);

    // The sweep is gated on `motion-safe:`, so reduced-motion users are left
    // with the static hatch underneath instead of a moving element.
    expect(sheen?.className).toContain(SWEEP_CLASS);
    expect(indicatorOf(bar).className).toContain("progress-hatch");
  });

  it("holds a warning-toned hatch, not a full fill, when a source needs attention", () => {
    const bar = renderBar(StartupReadinessPhase.NeedsAttention, {
      stage: "Startup needs attention",
    });

    // Design review, ISS-5115: a full-width warning fill reads as "finished in
    // warning tone", and an empty track reads as 0%. A stalled bar shows the
    // hatch — held, amount unknown — and no sweep.
    expect(bar.querySelector(SHEEN_SELECTOR)).toBeNull();
    expect(indicatorOf(bar).className).toContain("progress-hatch");
    expect(indicatorOf(bar).className).toContain("text-warning");
    expect(indicatorOf(bar).className).not.toContain("bg-transparent");
    expect(bar.className).toContain("bg-warning/20");
  });

  it("freezes the hatch rather than emptying the track when the user pauses history processing", () => {
    const bar = renderBar(StartupReadinessPhase.ProcessingHistory, {
      paused: true,
      stage: "History processing is paused",
    });

    expect(bar.querySelector(SHEEN_SELECTOR)).toBeNull();
    expect(indicatorOf(bar).className).toContain("progress-hatch");
    expect(indicatorOf(bar).className).not.toContain("bg-transparent");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  });
});
