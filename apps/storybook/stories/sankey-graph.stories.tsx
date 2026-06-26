import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { SankeyGraph } from "@repo/design-system/components/ui/primitives/sankey-graph";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Data Display/Data Visualization/Sankey Graph",
  component: SankeyGraph,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    flows: workflowData.toolFlow.transitions,
    totals: workflowData.toolFlow.toolCounts.map((item) => ({
      id: item.toolName,
      value: item.count,
    })),
    ariaLabel: "Tool flow sankey",
  },
} satisfies Meta<typeof SankeyGraph>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
