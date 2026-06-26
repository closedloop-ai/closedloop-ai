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

const meta: Meta<typeof Graph> = {
  title: "Design System/Data Display/Data Visualization/Graph",
  component: Graph,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    nodes,
    links,
    ariaLabel: "Workflow graph",
    legendLabel: "Agent types",
    edgeLegendLabel: "A hands off to B",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
