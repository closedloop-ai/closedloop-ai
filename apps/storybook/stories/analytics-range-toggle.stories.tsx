import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

function AnalyticsRangeToggleStory({
  value,
  onValueChange,
  ...args
}: ComponentProps<typeof AnalyticsRangeToggle>) {
  const [currentValue, setCurrentValue] = useState(value);
  return (
    <AnalyticsRangeToggle
      {...args}
      onValueChange={(next) => {
        setCurrentValue(next);
        onValueChange?.(next);
      }}
      value={currentValue}
    />
  );
}

const meta = {
  title: "Composites v1.0/Charts/Analytics Range Toggle",
  component: AnalyticsRangeToggle,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: 'The visible group name. Defaults to "Range".',
    },
    options: {
      control: false,
      description: "The segments to render, in display order.",
    },
    value: {
      control: false,
      description: "The currently selected segment's value.",
    },
  },
  args: {
    label: "Range",
    value: "30d",
    onValueChange: fn(),
    options: [
      { label: "7d", value: "7d" },
      { label: "30d", value: "30d" },
      { label: "90d", value: "90d" },
      { label: "All", value: "all" },
    ],
  },
  // key remounts the story when the Controls panel changes `value`,
  // re-seeding local state — plain React state, not a Storybook preview
  // hook, so it works in every rendering context (Canvas AND the autodocs
  // inline Docs page, where `useArgs()` throws at runtime; see
  // favorite-button.stories.tsx for the same fix on the same class of bug).
  render: (args) => (
    <AnalyticsRangeToggleStory key={String(args.value)} {...args} />
  ),
} satisfies Meta<typeof AnalyticsRangeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * No segments to select. The group label still renders; useful for
 * confirming a loading or not-yet-configured state doesn't collapse the
 * layout.
 */
export const Empty: Story = {
  args: {
    options: [],
  },
};

/**
 * Tabs into the group and asserts the SELECTED segment received focus, so the
 * keyboard-focus ring on the active `ToggleGroupItem` is both visible and
 * verified.
 *
 * Asserts the checked radio, not `getAllByRole("radio")[0]` (array index 0):
 * a `ToggleGroup` is a roving-tabindex radiogroup, so only the currently
 * checked item has `tabindex="0"` — every other segment is `tabindex="-1"`
 * and outside the Tab sequence entirely (WAI-ARIA APG "Radio Group"). Since
 * this story's default `value` is "30d", not the first option in the `options`
 * array ("7d"), asserting index 0 fails on a component that is behaving
 * correctly — confirmed by re-running against the real portable-stories
 * harness (`vitest run __tests__/story-sweep.test.tsx`), not just observed.
 */
export const Focus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole("radio", { checked: true })).toHaveFocus();
  },
};

const chartSeries = [
  { key: "accepted", label: "Accepted" },
  { key: "reworked", label: "Reworked" },
];

const chartPoints = [
  { date: "2026-06-08", values: { accepted: 12, reworked: 4 } },
  { date: "2026-06-09", values: { accepted: 18, reworked: 6 } },
  { date: "2026-06-10", values: { accepted: 16, reworked: 5 } },
  { date: "2026-06-11", values: { accepted: 24, reworked: 8 } },
  { date: "2026-06-12", values: { accepted: 29, reworked: 7 } },
  { date: "2026-06-13", values: { accepted: 34, reworked: 9 } },
];

/**
 * The toggle in its real context: controlling the range of the chart it
 * sits beside, matching how `AnalyticsPageShell` composes the two.
 */
export const RealisticUse: Story = {
  render: (args) => (
    <div className="w-[640px] space-y-3">
      <div className="flex items-center justify-end">
        <AnalyticsRangeToggleStory key={String(args.value)} {...args} />
      </div>
      <div className="h-80 rounded-lg border bg-background p-4">
        <TimeSeriesAreaChart points={chartPoints} series={chartSeries} />
      </div>
    </div>
  ),
};
