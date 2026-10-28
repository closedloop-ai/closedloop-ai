import { render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsCustomRangeControl } from "../sessions-custom-range-control";

const JANUARY_5_DAY_NAME = /January 5/;
const JANUARY_12_DAY_NAME = /January 12/;
const CLEAR_CONTROL_NAME = /Clear custom date range/;
const NEXT_MONTH_NAME = /Go to the Next Month/;
const FEBRUARY_5_2027_DAY_NAME = /February 5th, 2027/;
const JANUARY_5_2027_DAY_NAME = /January 5th, 2027/;
const OVER_MAXIMUM_MESSAGE = "Choose 366 days or fewer.";
const CUSTOM_TRIGGER_NAME = "Custom";
// ISS-8324. The two cases below drive 16-17 real interactions against a calendar
// that re-renders a 42-cell month grid on each one; every other case in this
// file is a render plus one or two clicks and lands in ~10-130ms. After the
// `walkForwardMonths` fix these measure 1.1-2.4s under V8 coverage
// instrumentation, so 5s left them under two seconds of headroom on a loaded
// runner — which is what `coverage-main` is. Sized to fail a hang, not
// contention, and deliberately NOT a file-wide default: the other seven cases
// keep the 5s fast-fail. Same shape as ISS-6939 in this same lane.
const MULTI_MONTH_INTERACTION_TIMEOUT_MS = 30_000;

/**
 * FEA-4201. The page suite proves the URL reaches the query; this proves the
 * CONTROL reaches the URL — that a two-click calendar selection emits the exact
 * pair of calendar days the user pressed, and that an active window can be read
 * and cleared without a mouse.
 *
 * Expected days are pinned literals, never derived by calling the same encoder
 * the control uses: the duplication is what makes this able to fail.
 */
describe("SessionsCustomRangeControl (FEA-4201)", () => {
  // With no window set the calendar opens on TODAY, so the days a fresh
  // selection can reach are whatever month the suite happens to run in. Pinning
  // the clock is what lets the expected pair below be a literal rather than a
  // re-derivation of the control's own encoding.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the exact from/to days a two-click selection names", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn();
    render(<SessionsCustomRangeControl onChange={onChange} value={null} />);

    await user.click(screen.getByRole("button", { name: CUSTOM_TRIGGER_NAME }));
    await user.click(
      await screen.findByRole("button", { name: JANUARY_5_DAY_NAME })
    );
    await user.click(screen.getByRole("button", { name: JANUARY_12_DAY_NAME }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith({
      from: "2026-01-05",
      to: "2026-01-12",
    });
  });

  /**
   * The calendar reports a first click as a ONE-DAY range, so a select-and-close
   * control would apply a single-day window the moment a user reached for the
   * first end of a longer one — and they would have to reopen the control to
   * discover it. Nothing reaches the listing until Apply.
   */
  it("changes nothing until Apply is pressed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn();
    render(<SessionsCustomRangeControl onChange={onChange} value={null} />);

    await user.click(screen.getByRole("button", { name: CUSTOM_TRIGGER_NAME }));
    await user.click(
      await screen.findByRole("button", { name: JANUARY_5_DAY_NAME })
    );
    await user.click(screen.getByRole("button", { name: JANUARY_12_DAY_NAME }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers no Apply until a day is chosen", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SessionsCustomRangeControl onChange={vi.fn()} value={null} />);

    await user.click(screen.getByRole("button", { name: CUSTOM_TRIGGER_NAME }));

    expect(await screen.findByRole("button", { name: "Apply" })).toBeDisabled();
  });

  /**
   * The active window is stated in WORDS on the trigger, so which control is
   * deciding the rows never depends on color alone (WCAG 1.4.1).
   */
  it("names a single-day window on the trigger", () => {
    render(
      <SessionsCustomRangeControl
        onChange={vi.fn()}
        value={{ from: "2026-01-01", to: "2026-01-01" }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Custom date range: Jan 1, 2026" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CUSTOM_TRIGGER_NAME })
    ).toBeNull();
  });

  it("names both ends of a multi-day window on the trigger", () => {
    render(
      <SessionsCustomRangeControl
        onChange={vi.fn()}
        value={{ from: "2026-01-01", to: "2026-01-08" }}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "Custom date range: Jan 1 - Jan 8, 2026",
      })
    ).toBeInTheDocument();
  });

  it("offers a keyboard-reachable clear that hands the listing back to the preset", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn();
    render(
      <SessionsCustomRangeControl
        onChange={onChange}
        value={{ from: "2026-01-01", to: "2026-01-08" }}
      />
    );

    const clear = screen.getByRole("button", {
      name: "Clear custom date range Jan 1 - Jan 8, 2026",
    });
    // Reached by tabbing, not by a synthetic click: a control that only responds
    // to a pointer is not operable, and `toBeVisible` would accept it.
    await user.tab();
    await user.tab();
    expect(clear).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("offers no clear when no explicit window is active", () => {
    render(<SessionsCustomRangeControl onChange={vi.fn()} value={null} />);

    expect(
      screen.queryByRole("button", { name: CLEAR_CONTROL_NAME })
    ).toBeNull();
  });

  /**
   * FEA-4201 (codex P2 / whitlockk review). The picker imposed no maximum, so a
   * selection wider than `MAX_SESSION_CUSTOM_WINDOW_DAYS` was written to the URL
   * and then thrown away by `parseSessionCustomDateWindowParams` on the very next
   * render: the popover closed, the listing fell back to the preset, and nothing
   * on screen accounted for the window the user had just chosen.
   *
   * Jan 5 2026 → Feb 5 2027 is 397 inclusive days. The span is REFUSED rather
   * than narrowed to the maximum, because a silent forward clamp is the same
   * dishonesty the parser already rejects for an inbound link.
   */
  it("refuses to apply a span past the maximum, and says why", {
    timeout: MULTI_MONTH_INTERACTION_TIMEOUT_MS,
  }, async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn();
    render(<SessionsCustomRangeControl onChange={onChange} value={null} />);

    await user.click(screen.getByRole("button", { name: CUSTOM_TRIGGER_NAME }));
    await user.click(
      await screen.findByRole("button", { name: JANUARY_5_DAY_NAME })
    );
    // Walk the calendar the way a user reaching a date 13 months out has to.
    await walkForwardMonths(user, 13);
    await user.click(
      screen.getByRole("button", { name: FEBRUARY_5_2027_DAY_NAME })
    );

    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    // The reason is a live region, not just visible text: the refusal appears
    // while focus is out on the calendar grid, so a sighted-only message would
    // leave a screen-reader user with a silently dead Apply.
    expect(screen.getByText(OVER_MAXIMUM_MESSAGE)).toHaveAttribute(
      "role",
      "status"
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * The boundary itself, from the other side: the widest ACCEPTED span must stay
   * appliable. Without this, disabling Apply on every multi-month selection would
   * satisfy the refusal test above while breaking the feature.
   */
  it("still applies a span exactly at the maximum", {
    timeout: MULTI_MONTH_INTERACTION_TIMEOUT_MS,
  }, async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn();
    render(<SessionsCustomRangeControl onChange={onChange} value={null} />);

    await user.click(screen.getByRole("button", { name: CUSTOM_TRIGGER_NAME }));
    await user.click(
      await screen.findByRole("button", { name: JANUARY_5_DAY_NAME })
    );
    // Jan 5 2026 → Jan 5 2027 is 366 inclusive days: 2026 is not a leap year,
    // so the span is exactly `MAX_SESSION_CUSTOM_WINDOW_DAYS`.
    await walkForwardMonths(user, 12);
    await user.click(
      screen.getByRole("button", { name: JANUARY_5_2027_DAY_NAME })
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith({
      from: "2026-01-05",
      to: "2027-01-05",
    });
  });
});

/**
 * One nav click per month — the popover shows a single month, so that is the
 * real cost of reaching a date a year out, and the two cases above pay it.
 *
 * ISS-8324: the nav control is resolved ONCE rather than per iteration, and that
 * is the whole reason this helper exists. `getByRole` with a name matcher has to
 * compute the accessible name of every button under the popover, and the
 * calendar renders ~42 day cells as buttons whose names are full dates — so each
 * in-loop lookup measured ~260ms against ~106ms for the click it wrapped, and
 * the 13 of them were 3.4s of a 4.8s test that then blew the 5s default and
 * reddened `coverage-main`. Nothing about the interaction changed: the same nav
 * control is pressed the same number of times.
 *
 * The node persists across month changes. If it ever stops doing so the clicks
 * land on a detached button, the calendar never leaves the month it opened on,
 * and the far date each caller looks for next is nowhere in the grid — so this
 * fails loudly rather than passing on a walk that did not happen.
 */
async function walkForwardMonths(user: UserEvent, months: number) {
  const next = screen.getByRole("button", { name: NEXT_MONTH_NAME });
  for (let month = 0; month < months; month += 1) {
    await user.click(next);
  }
}
