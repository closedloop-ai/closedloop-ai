import {
  Progress,
  ProgressTone,
} from "@closedloop-ai/design-system/components/ui/progress";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const LABEL = "Example progress";

/**
 * ISS-5115 guards the shared `Progress` primitive's honesty contract. It lives
 * here rather than beside the component because `@closedloop-ai/design-system` ships no
 * test runner, and the desktop renderer is the surface whose startup bar
 * depends on this contract holding.
 *
 * `value` is typed `number`, but a caller deriving a ratio can still produce
 * `NaN` (0/0) or an overshoot (a total that shrank underneath a running count),
 * so these inputs are reachable at runtime and are not type-forbidden cases.
 */
function renderProgress(props: {
  value?: number | null;
  max?: number;
  paused?: boolean;
  sweep?: boolean;
  tone?: ProgressTone;
}) {
  render(<Progress aria-label={LABEL} {...props} />);
  return screen.getByRole("progressbar", { name: LABEL });
}

function indicatorOf(bar: HTMLElement): HTMLElement | null {
  return bar.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
}

describe("Progress", () => {
  afterEach(cleanup);

  it("announces a value it was actually given", () => {
    const bar = renderProgress({ value: 62 });

    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(indicatorOf(bar)?.getAttribute("style")).toContain(
      "translateX(-38%)"
    );
  });

  it("refuses to report an overshoot as complete", () => {
    // Clamping 150 down to max would render a full bar with
    // aria-valuenow="100" and data-state="complete" — an affirmative "finished"
    // built from a number that was never valid.
    const bar = renderProgress({ value: 150 });

    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("data-state")).toBe("indeterminate");
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("treats %s as unknown rather than as zero", (_name, value) => {
    const bar = renderProgress({ value });

    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("data-state")).toBe("indeterminate");
    // Radix console.errors on a non-finite value it is handed, and browser code
    // must never emit that — so the guard has to run before the forward, not
    // rely on the transform swallowing it.
    expect(indicatorOf(bar)?.getAttribute("style")).toBeNull();
  });

  it("floors a negative value instead of inverting the fill", () => {
    const bar = renderProgress({ value: -20 });

    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(indicatorOf(bar)?.getAttribute("style")).toContain(
      "translateX(-100%)"
    );
  });

  it("scales the fill to a custom max", () => {
    const bar = renderProgress({ value: 5, max: 20 });

    expect(bar.getAttribute("aria-valuemax")).toBe("20");
    expect(indicatorOf(bar)?.getAttribute("style")).toContain(
      "translateX(-75%)"
    );
  });

  it("falls back to the default max rather than dividing by an unusable one", () => {
    // A zero max would divide into a NaN transform, which the browser drops —
    // leaving a full-width bar beside an aria-valuenow of 0.
    const bar = renderProgress({ value: 25, max: 0 });

    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(indicatorOf(bar)?.getAttribute("style")).toContain(
      "translateX(-75%)"
    );
  });

  it("hatches the track and sweeps it while indeterminate work is running", () => {
    const bar = renderProgress({ value: null });

    expect(indicatorOf(bar)?.className).toContain("progress-hatch");
    expect(bar.querySelector('[data-slot="progress-sheen"]')).not.toBeNull();
  });

  it("keeps the hatch and drops only the sheen once paused", () => {
    // A bare track is the most universal 0% there is, so pausing must not empty
    // the bar — it reads as held, not as reset.
    const bar = renderProgress({ value: null, paused: true });

    expect(indicatorOf(bar)?.className).toContain("progress-hatch");
    expect(indicatorOf(bar)?.className).not.toContain("bg-transparent");
    expect(indicatorOf(bar)?.getAttribute("data-paused")).toBe("true");
    expect(bar.querySelector('[data-slot="progress-sheen"]')).toBeNull();
  });

  it("carries a tone across the track, the fill and the indeterminate hatch", () => {
    // Tone is a prop rather than a per-caller child selector precisely so it
    // cannot recolour the determinate fill alone and leave the rest default.
    const determinate = renderProgress({
      value: 50,
      tone: ProgressTone.Success,
    });

    expect(determinate.className).toContain("bg-success/20");
    expect(indicatorOf(determinate)?.className).toContain("bg-success");
    expect(indicatorOf(determinate)?.className).not.toContain("bg-primary");

    cleanup();
    const indeterminate = renderProgress({
      value: null,
      tone: ProgressTone.Warning,
    });

    expect(indeterminate.className).toContain("bg-warning/20");
    expect(indicatorOf(indeterminate)?.className).toContain("text-warning");
    expect(
      indeterminate.querySelector('[data-slot="progress-sheen"]')?.className
    ).toContain("via-warning/60");
  });

  it("sweeps a determinate bar only when the caller opts in, and never once paused", () => {
    // `sweep` is the liveness signal for a bar whose value is known but whose
    // updater can block the main thread. It must stay off by default so no
    // existing determinate bar starts animating.
    const plain = renderProgress({ value: 40 });
    expect(plain.querySelector('[data-slot="progress-sheen"]')).toBeNull();

    cleanup();
    const swept = renderProgress({ value: 40, sweep: true });
    expect(swept.querySelector('[data-slot="progress-sheen"]')).not.toBeNull();
    expect(swept.getAttribute("aria-valuenow")).toBe("40");

    cleanup();
    const held = renderProgress({ value: 40, sweep: true, paused: true });
    expect(held.querySelector('[data-slot="progress-sheen"]')).toBeNull();
  });

  it("ignores `paused` on a determinate bar", () => {
    const bar = renderProgress({ value: 40, paused: true });

    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(indicatorOf(bar)?.getAttribute("style")).toContain(
      "translateX(-60%)"
    );
  });
});
