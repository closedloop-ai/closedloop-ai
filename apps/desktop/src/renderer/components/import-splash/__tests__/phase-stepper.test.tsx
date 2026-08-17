import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PhaseStep } from "../import-splash-state";
import { PhaseStepper } from "../phase-stepper";

describe("PhaseStepper", () => {
  it("marks steps before the active step as done and the active step as current", () => {
    render(<PhaseStepper activeStep={PhaseStep.Compute} />);

    const scan = screen.getByText("Scan");
    const importStep = screen.getByText("Import");
    const compute = screen.getByText("Compute");
    const ready = screen.getByText("Ready");

    expect(scan.getAttribute("aria-current")).toBeNull();
    expect(importStep.getAttribute("aria-current")).toBeNull();
    expect(compute.getAttribute("aria-current")).toBe("step");
    expect(ready.getAttribute("aria-current")).toBeNull();

    // aria-current alone can't tell done from pending — both lack it. Done
    // steps render a check icon in their dot; pending steps render a plain
    // number, so use that to tell the two apart.
    expect(scan.closest("li")?.querySelector("svg")).not.toBeNull();
    expect(importStep.closest("li")?.querySelector("svg")).not.toBeNull();
    expect(ready.closest("li")?.querySelector("svg")).toBeNull();
  });

  it("renders the failed step as an error instead of active", () => {
    render(<PhaseStepper activeStep={PhaseStep.Import} failed />);

    // The active-but-failed step drops aria-current (it reads as an error,
    // not the in-progress step) while still being visually distinguished.
    const importStep = screen.getByText("Import");
    expect(importStep.getAttribute("aria-current")).toBeNull();
    expect(importStep.className).toContain("text-destructive");
  });

  it("defaults failed to false so the active step reads as in-progress", () => {
    render(<PhaseStepper activeStep={PhaseStep.Scan} />);

    const scan = screen.getByText("Scan");
    expect(scan.getAttribute("aria-current")).toBe("step");
    expect(scan.className).not.toContain("text-destructive");
  });
});
