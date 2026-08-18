import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HarnessProgressList } from "../harness-progress-list";
import type { HarnessProgress } from "../import-splash-state";

function harness(overrides: Partial<HarnessProgress>): HarnessProgress {
  return {
    id: "claude",
    label: "Claude Code",
    total: 100,
    processed: 40,
    pct: 40,
    state: "active",
    ...overrides,
  };
}

describe("HarnessProgressList", () => {
  it("renders one row per harness with its label, count, and state-specific marker", () => {
    const { container } = render(
      <HarnessProgressList
        harnesses={[
          harness({ id: "claude", label: "Claude Code", state: "active" }),
          harness({
            id: "codex",
            label: "Codex",
            total: 50,
            processed: 50,
            pct: 100,
            state: "done",
          }),
          harness({
            id: "cursor",
            label: "Cursor",
            total: 10,
            processed: 2,
            pct: 20,
            state: "pending",
          }),
        ]}
      />
    );

    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.getByText("40 / 100")).toBeDefined();
    expect(screen.getByText("Codex")).toBeDefined();
    expect(screen.getByText("50 / 50")).toBeDefined();
    expect(screen.getByText("Cursor")).toBeDefined();
    expect(screen.getByText("2 / 10")).toBeDefined();

    const items = container.querySelectorAll("li");
    const claudeItem = items[0];
    const activeDot = claudeItem.querySelector("[data-ob-motion]");
    expect(activeDot).not.toBeNull();

    const codexItem = items[1];
    const checkIcon = codexItem.querySelector("svg.text-success");
    expect(checkIcon).not.toBeNull();

    const cursorItem = items[2];
    const pendingDot = cursorItem.querySelector(
      "span.rounded-full:not([data-ob-motion])"
    );
    expect(pendingDot).not.toBeNull();
  });

  it("renders no rows when the harness list is empty", () => {
    render(<HarnessProgressList harnesses={[]} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("sets the accessible label and fill width on each harness's progress bar", () => {
    render(
      <HarnessProgressList
        harnesses={[harness({ label: "Cursor", pct: 62 })]}
      />
    );

    const bar = screen.getByRole("progressbar", {
      name: "Cursor import progress",
    });
    const indicator = bar.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("style")).toContain("translateX(-38%)");
    // ISS-5115: the shared `Progress` used to drop `value` before it reached
    // Radix, so this named progressbar reported nothing to assistive tech.
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(bar.getAttribute("data-state")).toBe("loading");
  });

  it("marks an errored harness with a destructive icon and count styling", () => {
    const { container } = render(
      <HarnessProgressList
        harnesses={[
          harness({
            label: "Gemini CLI",
            state: "error",
            processed: 3,
            total: 10,
            pct: 30,
          }),
        ]}
      />
    );

    const count = screen.getByText("3 / 10");
    expect(count.className).toContain("text-destructive");
    const errorIcon = container.querySelector("svg.text-destructive");
    expect(errorIcon).not.toBeNull();
  });
});
