import { sessionOverviewStats } from "@repo/app/agents/lib/session-mock-data";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import type { Meta, StoryObj } from "@storybook/react";

const totalTokens = Object.values(sessionOverviewStats.tokens).reduce(
  (sum, value) => sum + value,
  0
);

const SegmentedBarCanvas = () => (
  <div className="w-[720px] rounded-xl border border-border/80 bg-card p-4">
    <SegmentedBar
      segments={[
        {
          key: "cache-read",
          label: "Cache read",
          value: sessionOverviewStats.tokens.cacheReadTokens,
          colorClassName: "bg-sky-500",
          textClassName: "text-sky-300",
        },
        {
          key: "cache-write",
          label: "Cache write",
          value: sessionOverviewStats.tokens.cacheWriteTokens,
          colorClassName: "bg-violet-500",
          textClassName: "text-violet-300",
        },
        {
          key: "input",
          label: "Input",
          value: sessionOverviewStats.tokens.inputTokens,
          colorClassName: "bg-emerald-500",
          textClassName: "text-emerald-300",
        },
        {
          key: "output",
          label: "Output",
          value: sessionOverviewStats.tokens.outputTokens,
          colorClassName: "bg-orange-500",
          textClassName: "text-orange-300",
        },
      ]}
      total={totalTokens}
    />
  </div>
);

const meta = {
  title: "Design System/Data Display/Data Visualization/Segmented Bar",
  component: SegmentedBarCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof SegmentedBarCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
