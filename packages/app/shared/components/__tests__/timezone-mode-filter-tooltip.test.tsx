import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  TIMEZONE_MODE_CONTROL_HINT,
  TIMEZONE_MODE_CONTROL_LABEL,
  TimezoneMode,
} from "../../lib/date-window-timezone-mode";
import { TimezoneModeFilter } from "../timezone-mode-filter";

const TRIGGER_SELECTOR = '[data-slot="tooltip-trigger"]';

function renderFilter() {
  return render(
    <TimezoneModeFilter onChange={() => undefined} value={TimezoneMode.Utc} />
  );
}

/**
 * ISS-9619 (whitlockk + codex review) — the control's hover text actually opens.
 *
 * `TooltipTrigger asChild` merges its pointer/focus handlers and its ref into
 * its direct child. That child was `DateRangeFilter`, a plain function component
 * that forwards no ref and spreads no unknown props onto its `ToggleGroup`, so
 * every handler was dropped on the floor and the tooltip could never open —
 * while the component still rendered, still typechecked, and still passed every
 * test that only asserted the pills. The control is the one whose neighbour
 * explains itself on hover, and "Local" is the word a reader cannot resolve
 * alone, so a silently-dead tooltip is the whole affordance missing.
 */
describe("TimezoneModeFilter tooltip (ISS-9619)", () => {
  it("mounts the tooltip trigger on a DOM element wrapping the control", () => {
    const { container } = renderFilter();

    const trigger = container.querySelector(TRIGGER_SELECTOR);
    const control = container.querySelector(
      `[aria-label="${TIMEZONE_MODE_CONTROL_LABEL}"]`
    );

    // Positive control on the same query: the control itself IS there, so a
    // missing trigger below cannot be a selector that never resolves.
    expect(control).not.toBeNull();
    expect(trigger).not.toBeNull();
    // The trigger wraps the control rather than BEING it — handing the trigger
    // to `DateRangeFilter` is exactly what dropped the handlers.
    expect(trigger).not.toBe(control);
    expect(trigger?.contains(control as Node)).toBe(true);
  });

  it("opens the hint when the control takes focus", async () => {
    const { container } = renderFilter();
    const trigger = container.querySelector(TRIGGER_SELECTOR);
    if (trigger === null) {
      throw new Error("no tooltip trigger rendered");
    }

    // Absence first, paired with the positive assertion below on the SAME query,
    // so this cannot pass against a matcher that never resolves either way.
    expect(screen.queryAllByText(TIMEZONE_MODE_CONTROL_HINT)).toHaveLength(0);

    fireEvent.focusIn(trigger);

    // `findAllByText`, not `findByText`: Radix renders the hint twice — the
    // visible content plus a visually-hidden `role="tooltip"` mirror for the
    // accessibility tree — so the singular matcher is ambiguous on success.
    expect(
      (await screen.findAllByText(TIMEZONE_MODE_CONTROL_HINT)).length
    ).toBeGreaterThan(0);
    // The accessible name is the half a reader on a screen reader actually gets.
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      TIMEZONE_MODE_CONTROL_HINT
    );
  });
});
