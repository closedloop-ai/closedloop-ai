import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { SankeyGraph } from "@repo/design-system/components/ui/primitives/sankey-graph";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A flow diagram of ribbons sized by how much value moves between nodes, for
 * when the relative size of each flow matters more than one connection.
 */
const meta = {
  title: "Primitives/Charts/Sankey Graph",
  component: SankeyGraph,
  tags: ["autodocs"],
  argTypes: {
    flows: {
      control: "object",
      description:
        "Edges of the diagram as `{ source, target, value }`. Node ids are derived from these names.",
    },
    totals: {
      control: "object",
      description:
        "Per-node totals as `{ id, value }`, used for the node labels and tooltip shares.",
    },
    palette: {
      control: "object",
      description:
        "Node id to CSS colour. Ids missing from the map fall back to the built-in tool colours.",
    },
    ariaLabel: {
      control: "text",
      description: "Accessible name for the rendered `svg`.",
    },
    emptyMessage: {
      control: "text",
      description: "Copy shown in place of the diagram when `flows` is empty.",
    },
    labelFormatter: {
      control: false,
      description: "Maps a node id to its display label.",
    },
  },
  parameters: { layout: "fullscreen" },
  args: {
    flows: workflowData.toolFlow.transitions,
    totals: workflowData.toolFlow.toolCounts.map((item) => ({
      id: item.toolName,
      value: item.count,
    })),
    ariaLabel: "Tool flow sankey",
    emptyMessage: "No data",
  },
} satisfies Meta<typeof SankeyGraph>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
