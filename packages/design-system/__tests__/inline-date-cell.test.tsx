import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-6384 — the `date` variant. Its whole reason to exist is that it must NOT
 * be an `<input type="date">`, and that a popover cancels through a completely
 * different mechanism than the text branch's `cancelingRef` while owing the
 * reader the same promise. Every case below pins one of those two.
 */
describe("InlineScalarCell (date)", () => {
  // The calendar takes `selected` but no `defaultMonth`, so it opens on the
  // CURRENT month rather than the selected value's. The day cells the cases
  // below click are therefore only the dates they name while the wall clock
  // sits in August 2026 — unpinned, this block went red on 2026-09-01 asserting
  // 2026-08-20 against a September grid, and the toggle-to-clear case clicked
  // an unselected day and committed instead. Midday UTC keeps the local date on
  // the 17th in every zone the suite runs in (UTC in CI, Chicago locally).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to the date picker instead of a native date input", () => {
    const { container } = render(
      <InlineScalarCell
        label="Due date"
        onCommit={vi.fn()}
        type="date"
        value="2026-08-17"
      />
    );

    // The point of the variant: a browser-native calendar is untokenized and
    // unreachable by the design system, so there must be no date input at all.
    expect(container.querySelector('input[type="date"]')).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "Due date: Aug 17, 2026",
    });
    // Radix marks the trigger as a disclosure; a control that opens a calendar
    // and does not say so is unusable from a screen reader.
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not commit when the picker is dismissed instead of used", async () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        type="date"
        value="2026-08-17"
      />
    );

    const trigger = screen.getByRole("button", {
      name: "Due date: Aug 17, 2026",
    });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    // The popover's cancel path. The text branch needs `cancelingRef` because
    // Escape blurs THROUGH the commit; here the calendar simply closes, and
    // nothing may be written on the way out.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    ).toBeInTheDocument();
  });

  it("commits the day the user picked, as a local ISO date", async () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    // `2026-08-20`, not `2026-08-19` — a UTC parse would move a due date a day
    // west of Greenwich.
    expect(onCommit).toHaveBeenCalledWith("2026-08-20");
  });

  it("clears the date when the day already selected is clicked again", async () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    // The picker's single-mode TOGGLE. This is what `DueDateCell` does on this
    // same popover today, and adopting the shared cell must not quietly
    // suppress it — a same-value guard here would have, by turning the one way
    // to clear a date from the calendar into a no-op.
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "17"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith("");
    // Cleared means the cell offers to set one again, not that it keeps showing
    // the date it just dropped.
    expect(
      await screen.findByRole("button", { name: "Set Due date" })
    ).toBeInTheDocument();
  });

  it("PRD-722 DT-072 restores confirmation after a compatibility-mode rejection", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("nope")));
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
      ).toBeInTheDocument()
    );
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("2026-08-20");
    expect(
      screen.queryByRole("button", { name: "Due date: Aug 20, 2026" })
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    ).not.toHaveAttribute("aria-invalid");
  });

  it("keeps and marks the rejected day for correction", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("nope")));
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Due date: Aug 20, 2026" })
      ).toBeInTheDocument()
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("PRD-722 DT-055 retries the same rejected day instead of toggling it clear", async () => {
    const onCommit = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(undefined);
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));
    const failedTrigger = await screen.findByRole("button", {
      name: "Due date: Aug 20, 2026",
    });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));

    fireEvent.click(failedTrigger);
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit).toHaveBeenNthCalledWith(1, "2026-08-20");
    expect(onCommit).toHaveBeenNthCalledWith(2, "2026-08-20");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Due date: Aug 20, 2026" })
    ).toBeInTheDocument();
  });

  it("PRD-722 DT-055 restores the confirmed date when Escape cancels a rejected day", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("nope")));
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));
    const failedTrigger = await screen.findByRole("button", {
      name: "Due date: Aug 20, 2026",
    });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(failedTrigger, { key: "Escape" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    ).toBeInTheDocument();
  });

  it("restores the confirmed date instead of clearing it when its highlighted day is clicked after a refusal", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("nope")));
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage="Save failed"
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));
    const failedTrigger = await screen.findByRole("button", {
      name: "Due date: Aug 20, 2026",
    });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));

    fireEvent.click(failedTrigger);
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "17"));

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("2026-08-20");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    ).toBeInTheDocument();
  });

  it("does not steal focus after an async date refusal when the user moved on", async () => {
    let rejectCommit: ((reason: unknown) => void) | undefined;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCommit = reject;
        })
    );
    render(
      <>
        <InlineScalarCell
          label="Due date"
          onCommit={onCommit}
          retainRejectedDraft
          saveErrorMessage="Save failed"
          type="date"
          value="2026-08-17"
        />
        <button type="button">Next</button>
      </>
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));
    const next = screen.getByRole("button", { name: "Next" });
    act(() => next.focus());
    await act(async () => {
      rejectCommit?.(new Error("refused"));
      await Promise.resolve();
    });

    expect(next).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Due date: Aug 20, 2026" })
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("names the empty cell by what activating it does, and reads it read-only", () => {
    const { rerender } = render(
      <InlineScalarCell
        label="Due date"
        onCommit={vi.fn()}
        type="date"
        value=""
      />
    );

    expect(
      screen.getByRole("button", { name: "Set Due date" })
    ).toBeInTheDocument();

    rerender(
      <InlineScalarCell
        label="Due date"
        onCommit={vi.fn()}
        readOnly
        type="date"
        value="2026-08-17"
      />
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Aug 17, 2026")).toBeInTheDocument();
  });
});

/**
 * ISS-8296 (davetho review): the month the picker OPENS on, pinned.
 *
 * `DatePickerPopover` passed `selected` and no `defaultMonth`, and
 * react-day-picker resolves the shown month as `month ?? defaultMonth ?? today`
 * — never from `selected`. The cases above could not see it: they select in
 * August and assert an August result, which is satisfied either way for as long
 * as the wall clock also sits in August. That is not a test, it is a
 * coincidence with an expiry date, and it expired on its own at 2026-09-01 UTC
 * with no code change.
 *
 * So this pins a "today" in a DIFFERENT month from the value, which is the only
 * arrangement where the two candidate anchors disagree.
 */
describe("InlineScalarCell (date) — the month the picker opens on", () => {
  afterEach(() => {
    // Unconditional, never the last line of the case: an assertion that throws
    // above would otherwise leak a frozen clock into every later test here.
    vi.useRealTimers();
  });

  it("opens on the month of its own value, not on today's month", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));

    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("August 2026")).toBeInTheDocument();
    expect(within(dialog).queryByText("November 2026")).not.toBeInTheDocument();

    // The consequence, not just the heading: anchored on November, "20" is a
    // November day and this commits `2026-11-20` — a due date moved a quarter.
    fireEvent.click(dayCell(dialog, "20"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("2026-08-20"));
  });
});

/**
 * The day button for a day-of-month, inside an open picker.
 *
 * Deliberately a TEXT query and not `getByRole("gridcell", { name })`: the role
 * query computes an accessible name for all ~42 cells of the month grid, which
 * on this tree takes long enough to blow the runner's default per-test clock
 * before the click ever happens. Scoped to the dialog so a day number cannot
 * match the cell value behind the popover.
 */
function dayCell(dialog: HTMLElement, dayOfMonth: string): HTMLElement {
  return within(dialog).getByText(dayOfMonth);
}
