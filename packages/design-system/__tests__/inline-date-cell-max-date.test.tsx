import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRD-722: a host whose storage stops at a day (a custom-field date stops at
 * 9999-12-31) bounds the picker through `maxDate`, the bound a native date
 * input's `max` used to carry. Two days either side of the bound pin that the
 * cut falls on it rather than on the month.
 */
describe("InlineScalarCell (date) maxDate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disables the days after the bound and leaves the bound itself", async () => {
    render(
      <InlineScalarCell
        label="Due date"
        maxDate="2026-08-20"
        onCommit={vi.fn()}
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    const calendar = await screen.findByRole("dialog");
    const day = (n: number) =>
      within(calendar)
        .getAllByRole("button")
        .find((button) => button.textContent === String(n));

    expect(day(20)).toBeEnabled();
    expect(day(21)).toBeDisabled();
  });
});
