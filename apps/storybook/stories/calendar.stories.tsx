import { Calendar } from "@repo/design-system/components/ui/calendar";
import type { Meta, StoryObj } from "@storybook/react";
import { addDays } from "date-fns";
import { action } from "storybook/actions";

/**
 * Fixed reference day every story below derives from, so the rendered grid is
 * identical on every run (ISS-5286).
 *
 * Constructed from local date components rather than parsed from `"2025-06-11"`
 * — an ISO date string parses as UTC midnight, which renders as June 10 for any
 * viewer west of Greenwich and would reintroduce nondeterminism by timezone
 * instead of by clock.
 *
 * Mid-month on purpose: the largest offset any story adds is +8 days, so every
 * derived date stays inside June and stays visible in the rendered grid. A base
 * near month-end would push `Multiple`'s third selection into the next month.
 *
 * `defaultMonth` is REQUIRED, not redundant with `selected`, and omitting it is a
 * silent trap: react-day-picker picks the displayed month with
 * `month || defaultMonth || today` and never consults `selected`
 * (`helpers/getInitialMonth.js`), and this design-system wrapper spreads props
 * through without defaulting it. Pin only `selected` and the grid keeps rendering
 * the real current month while the pinned dates sit in June 2025 — so `Default`,
 * `Multiple`, `Range`, and `Disabled` render with nothing selected or disabled at
 * all, which is the entire thing those stories exist to show.
 *
 * `today` is pinned for a different and weaker reason: it is NOT needed for
 * determinism (the real clock will never fall inside June 2025, so the today
 * modifier is simply absent from every render either way). It is pinned so that
 * modifier renders as a real, fixed state — `data-today="true"` on the reference
 * day — instead of being permanently missing from a component whose whole job is
 * showing dates, and so determinism stops depending on the reference date
 * staying in the past.
 */
const REFERENCE_DATE = new Date(2025, 5, 11);

/**
 * A date field component that allows users to enter and edit date.
 */
const meta = {
  title: "Design System/Primitives/Calendar",
  component: Calendar,
  tags: ["autodocs"],
  argTypes: {
    // `mode` stays out of the panel: `selected` has to match the mode's shape
    // (Date, Date[], or DateRange), so flipping mode alone throws inside
    // react-day-picker. The Multiple and Range stories below cover the modes.
    mode: {
      control: false,
      description:
        "Selection mode. Set per story because `selected` has to carry the matching shape.",
    },
    selected: { control: false },
    defaultMonth: { control: false },
    today: { control: false },
    disabled: { control: false },
    onSelect: { control: false, table: { category: "Events" } },
    captionLayout: {
      options: ["label", "dropdown", "dropdown-months", "dropdown-years"],
      control: { type: "radio" },
      description:
        "Whether the caption is static text or month/year dropdowns.",
    },
    buttonVariant: {
      options: [
        "default",
        "destructive",
        "outline",
        "secondary",
        "ghost",
        "link",
        "linkForeground",
      ],
      control: { type: "select" },
      description: "Button variant used for the previous and next nav buttons.",
    },
    numberOfMonths: {
      control: { type: "number", min: 1, max: 4, step: 1 },
    },
    showOutsideDays: { control: "boolean" },
    fixedWeeks: { control: "boolean" },
    showWeekNumber: { control: "boolean" },
    className: { control: "text" },
  },
  args: {
    mode: "single",
    selected: REFERENCE_DATE,
    defaultMonth: REFERENCE_DATE,
    today: REFERENCE_DATE,
    onSelect: action("onDayClick"),
    className: "rounded-md border w-fit",
    captionLayout: "label",
    buttonVariant: "ghost",
    numberOfMonths: 1,
    showOutsideDays: true,
    fixedWeeks: false,
    showWeekNumber: false,
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Calendar>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the calendar.
 */
export const Default: Story = {};

/**
 * Use the `multiple` mode to select multiple dates.
 */
export const Multiple: Story = {
  args: {
    min: 1,
    selected: [
      REFERENCE_DATE,
      addDays(REFERENCE_DATE, 2),
      addDays(REFERENCE_DATE, 8),
    ],
    mode: "multiple",
  },
};

/**
 * Use the `range` mode to select a range of dates.
 */
export const Range: Story = {
  args: {
    selected: {
      from: REFERENCE_DATE,
      to: addDays(REFERENCE_DATE, 7),
    },
    mode: "range",
  },
};

/**
 * Use the `disabled` prop to disable specific dates.
 */
export const Disabled: Story = {
  args: {
    disabled: [
      addDays(REFERENCE_DATE, 1),
      addDays(REFERENCE_DATE, 2),
      addDays(REFERENCE_DATE, 3),
      addDays(REFERENCE_DATE, 5),
    ],
  },
};

/**
 * Use the `numberOfMonths` prop to display multiple months.
 */
export const MultipleMonths: Story = {
  args: {
    numberOfMonths: 2,
    showOutsideDays: false,
  },
};
