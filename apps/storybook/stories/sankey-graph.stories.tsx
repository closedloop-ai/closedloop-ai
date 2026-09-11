import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { SankeyGraph } from "@repo/design-system/components/ui/primitives/sankey-graph";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A flow diagram where nodes are connected by ribbons whose thickness shows
 * how much value moves between them, read left to right. Reach for it when
 * the relative size of each flow matters more than any single connection;
 * use Graph instead for a general node-link diagram, and Agent Pipeline
 * Graph for the pre-built agent-handoff version of that. Node totals are
 * supplied separately from the flows, so a node's label and its tooltip
 * share come from your own totals rather than being recalculated from the
 * ribbons, and any id missing from the color map falls back to a small set
 * of built-in tool colors.
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
