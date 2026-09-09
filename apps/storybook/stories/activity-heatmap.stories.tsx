import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";
import type { Meta, StoryObj } from "@storybook/react";

const start = new Date("2026-03-01T12:00:00.000Z");
const weeks: AnalyticsHeatmapWeek[] = Array.from(
  { length: 14 },
  (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + weekIndex * 7 + dayIndex);
      return {
        date: date.toISOString().slice(0, 10),
        count: Math.max(
          0,
          Math.round(
            Math.sin((weekIndex + dayIndex) / 2) * 40 + 45 - dayIndex * 3
          )
        ),
      };
    })
);

const meta = {
  title: "Design System/Data Display/Data Visualization/Activity Heatmap",
  component: ActivityHeatmap,
  tags: ["autodocs"],
  argTypes: {
    weeks: {
      control: "object",
      description:
        "Sunday-started weeks of { date, count } cells, oldest week first.",
    },
    label: {
      control: "text",
      description: "Accessible name for the whole grid.",
    },
    accentVar: {
      control: "text",
      description:
        "Design-system color token the density ramp mixes from, written without var(), such as --primary or --success.",
    },
    valueFormatter: {
      control: false,
      description:
        "Formats a cell value for its tooltip and accessible label. Defaults to a plain event count.",
    },
  },
  parameters: { layout: "padded" },
  args: { weeks, label: "Activity by day", accentVar: "--primary" },
} satisfies Meta<typeof ActivityHeatmap>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

// A cost-metric heatmap: cells carry USD spend, so a custom `valueFormatter`
// renders each day's tooltip and accessible label as currency instead of the
// default "N events".
export const CurrencyTooltips: Story = {
  args: {
    valueFormatter: (count) =>
      count.toLocaleString("en-US", { style: "currency", currency: "USD" }),
  },
};

// Product surfaces name each instance (dashboards can pin several heatmaps) and
// can re-hue the ramp off any design-system color token — here contributions
// read green off `--success` instead of the default `--primary`.
export const NamedGreenAccent: Story = {
  args: {
    label: "Contributions by day",
    accentVar: "--success",
    valueFormatter: (count) =>
      `${count.toLocaleString()} contribution${count === 1 ? "" : "s"}`,
  },
};
