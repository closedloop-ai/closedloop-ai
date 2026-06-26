import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { LineChart } from "@repo/design-system/components/ui/primitives/line-chart";
import type { Meta, StoryObj } from "@storybook/react";

const LineChartCanvas = () => (
  <div className="w-[380px] rounded-xl border border-border/80 bg-card p-4">
    <LineChart
      color="#22c55e"
      label="Subagent trend"
      points={
        workflowData.effectiveness[0]?.trend.map((value, index) => ({
          label: `Run ${index + 1}`,
          value,
        })) ?? []
      }
    />
  </div>
);

const meta = {
  title: "Design System/Data Display/Data Visualization/Line Chart",
  component: LineChartCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof LineChartCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
