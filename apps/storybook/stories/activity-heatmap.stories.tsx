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
  parameters: { layout: "padded" },
  args: { weeks },
} satisfies Meta<typeof ActivityHeatmap>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

// A cost-metric heatmap: cells carry USD spend, so a custom `valueFormatter`
// renders each day's tooltip as currency instead of the default "N events".
export const CurrencyTooltips: Story = {
  args: {
    valueFormatter: (count) =>
      count.toLocaleString("en-US", { style: "currency", currency: "USD" }),
  },
};
