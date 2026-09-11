import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { Graph } from "@repo/design-system/components/ui/primitives/graph";
import type { Meta, StoryObj } from "@storybook/react";

const nodes = [
  { id: "main", label: "Main Agent", value: 1500 },
  { id: "planner", label: "Planner", value: 744 },
  { id: "verifier", label: "Verifier", value: 539 },
  { id: "review", label: "Review", value: 305 },
  { id: "completed", label: "Completed", value: 6800 },
  { id: "error", label: "Error", value: 5 },
];

const links = workflowData.cooccurrence.slice(0, 8).map((link) => ({
  source: link.source === "general-purpose" ? "main" : link.source,
  target: link.target === "general-purpose" ? "completed" : link.target,
  weight: link.weight,
  label: `${String(link.weight)}x`,
}));

/**
 * A force directed diagram of connected nodes for open-ended relationship
 * data, where individual connections matter more than overall volume.
 */
const meta: Meta<typeof Graph> = {
  title: "Primitives/Charts/Graph",
  component: Graph,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  // The Graph sizes to its container (FEA-3622); frame it in a fixed-height card
  // so the story mirrors the dashboard slot it ships in and stays contained.
  decorators: [
    (Story) => (
      <div className="h-[340px] w-full overflow-hidden rounded-lg border p-4">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    nodes: {
      control: "object",
      table: { category: "Content" },
      description:
        "Graph nodes. `value` drives the radius; `color` and `strokeColor` are optional overrides.",
    },
    links: {
      control: "object",
      table: { category: "Content" },
      description:
        "Edges between nodes. `source` and `target` must match node ids.",
    },
    emptyMessage: {
      control: "text",
      table: { category: "Content" },
      description: "Shown in place of the canvas when there are no nodes.",
    },
    ariaLabel: { control: "text", table: { category: "Labels" } },
    legendLabel: { control: "text", table: { category: "Labels" } },
    edgeLegendLabel: { control: "text", table: { category: "Labels" } },
    getNodeRows: { control: false, table: { category: "Tooltips" } },
    getLinkRows: { control: false, table: { category: "Tooltips" } },
    getNodeDescription: { control: false, table: { category: "Tooltips" } },
    getLinkDescription: { control: false, table: { category: "Tooltips" } },
  },
  args: {
    nodes,
    links,
    ariaLabel: "Workflow graph",
    legendLabel: "Agent types",
    edgeLegendLabel: "A hands off to B",
    emptyMessage: "No data",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
