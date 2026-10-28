import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  MAX_SESSION_CUSTOM_WINDOW_DAYS,
  type SessionCustomDateWindow,
} from "../../lib/session-custom-date-window";
import { SessionsCustomRangeControl } from "./sessions-custom-range-control";

/**
 * FEA-4201 — the Sessions toolbar's explicit from/to window control, isolated.
 *
 * Only mounts when a host supplies `onCustomDateWindowChange` — none of the
 * `SessionsToolbar` stories do, so this control had never actually rendered
 * anywhere in Storybook. A small controlled wrapper stands in for that host
 * here so the trigger, the calendar popover, and the applied/cleared states
 * are all reviewable on their own.
 */
function SessionsCustomRangeControlDemo({
  initialValue,
}: {
  initialValue: SessionCustomDateWindow | null;
}) {
  const [value, setValue] = useState<SessionCustomDateWindow | null>(
    initialValue
  );
  return <SessionsCustomRangeControl onChange={setValue} value={value} />;
}

const meta = {
  title: "Composites v1.0/Sessions/Sessions Custom Range Control",
  component: SessionsCustomRangeControlDemo,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
  args: {
    initialValue: null,
  },
  render: (args) => (
    <SessionsCustomRangeControlDemo
      key={remountKey(args.initialValue)}
      {...args}
    />
  ),
} satisfies Meta<typeof SessionsCustomRangeControlDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * No explicit window applied — a rolling preset is in charge. The trigger
 * reads "Custom" and there is no clear button. Open it to see the range
 * calendar and the disabled Apply state before both ends are chosen.
 */
export const Default: Story = {};

/**
 * An explicit window is already applied. The trigger states the window in
 * words rather than relying on styling alone, and the clear button appears
 * beside it.
 */
export const WithSelectedWindow: Story = {
  args: {
    initialValue: { from: "2026-08-25", to: "2026-09-05" },
  },
};

/** Comfortably past the cap so the walk below can never land back under it. */
const OVER_MAXIMUM_SPAN_DAYS = MAX_SESSION_CUSTOM_WINDOW_DAYS + 34;
const NEXT_MONTH_NAME = /Go to the Next Month/;

/**
 * The day button the component itself renders for `date` — matched on the
 * same `data-day` locale string `CalendarDayButton` stamps on every cell,
 * rather than its formatted accessible name (which spells out weekday and an
 * ordinal suffix react-day-picker owns). Computed in this same browser
 * context, so it matches regardless of locale or timezone, and waits because
 * the popover's calendar mounts through a portal after Radix's own open
 * animation.
 */
function findDayButton(doc: Document, date: Date): Promise<HTMLButtonElement> {
  const dataDay = date.toLocaleDateString();
  return waitFor(() => {
    const button = doc.querySelector<HTMLButtonElement>(
      `button[data-day="${dataDay}"]`
    );
    if (!button) {
      throw new Error(`No calendar day button for ${dataDay}`);
    }
    return button;
  });
}

/**
 * ISS-8324 — a span past {@link MAX_SESSION_CUSTOM_WINDOW_DAYS} is REFUSED,
 * not narrowed: Apply stays disabled and the reason renders as a
 * `role="status"` live region, because a sighted-only message would leave a
 * screen-reader user with a silently dead Apply. Never exercised by any
 * story before this one.
 *
 * The two calendar clicks land on the 1st of whichever month is open when the
 * popover mounts (today's, since no window is set) and a day
 * {@link OVER_MAXIMUM_SPAN_DAYS} later, walking the single-month calendar
 * forward with its own "Next Month" control exactly as a user reaching a date
 * over a year out has to — so the story works on whatever day the suite
 * happens to run, the same way the component's own test file pins this case.
 */
export const OverMaximumSpan: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = canvasElement.ownerDocument;
    const body = within(doc.body);

    await userEvent.click(canvas.getByRole("button", { name: "Custom" }));

    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(start);
    end.setDate(start.getDate() + OVER_MAXIMUM_SPAN_DAYS);
    const monthsForward =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth());

    await userEvent.click(await findDayButton(doc, start));

    const nextMonth = await body.findByRole("button", {
      name: NEXT_MONTH_NAME,
    });
    for (let month = 0; month < monthsForward; month += 1) {
      await userEvent.click(nextMonth);
    }
    await userEvent.click(await findDayButton(doc, end));

    const warning = body.getByText(
      `Choose ${MAX_SESSION_CUSTOM_WINDOW_DAYS} days or fewer.`
    );
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute("role", "status");
    await expect(body.getByRole("button", { name: "Apply" })).toBeDisabled();
  },
};
