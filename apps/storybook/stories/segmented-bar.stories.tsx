import { sessionOverviewStats } from "@repo/app/agents/lib/session-mock-data";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import type { Meta, StoryObj } from "@storybook/react";

const totalTokens = Object.values(sessionOverviewStats.tokens).reduce(
  (sum, value) => sum + value,
  0
);

const SegmentedBarCanvas = (props: Parameters<typeof SegmentedBar>[0]) => (
  <div className="w-[720px] rounded-xl border border-border/80 bg-card p-4">
    <SegmentedBar {...props} />
  </div>
);

const meta = {
  title: "Design System/Data Display/Data Visualization/Segmented Bar",
  component: SegmentedBarCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    segments: {
      control: "object",
      description:
        "Each segment needs a key, a label, a raw value, and the class that colors its slice.",
    },
    total: {
      control: { type: "number", min: 0, max: 200_000_000, step: 100_000 },
      description:
        "Denominator every segment percentage is measured against, not the sum of the segments.",
    },
    className: {
      control: "text",
    },
  },
  args: {
    segments: [
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
    ],
    total: totalTokens,
  },
} satisfies Meta<typeof SegmentedBarCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
