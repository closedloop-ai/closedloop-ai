import { metrics } from "@repo/app/agents/lib/session-mock-data";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { Meta, StoryObj } from "@storybook/react";

const MetricCardCanvas = () => (
  <div className="grid w-[960px] gap-4 md:grid-cols-2 xl:grid-cols-4">
    {metrics.map((metric) => (
      <MetricCard key={metric.label} {...metric} />
    ))}
  </div>
);

const meta = {
  title: "Design System/Primitives/Metric Card",
  component: MetricCardCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof MetricCardCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
