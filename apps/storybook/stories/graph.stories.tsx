import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import { Graph } from "@repo/design-system/components/ui/primitives/graph";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

const links = workflowData.cooccurrence.map((link) => ({
  source: link.source,
  target: link.target,
  weight: link.weight,
  label: `${String(link.weight)}x`,
}));

/**
 * Nodes are DERIVED from the links rather than listed by hand.
 *
 * `Graph` drops any link whose source or target is not in the node set, and a
 * graph with no surviving links renders `emptyMessage` instead of a diagram.
 * This story used to carry its own list of six ids, and the mock data it draws
 * edges from names five different agents, so every link was discarded and the
 * chart read "No data" with nothing in the console to say why. One id was off
 * by two letters: the list had `review`, the data has `reviewer`.
 *
 * Deriving them means the two sets cannot disagree again. `value` drives the
 * node radius, so it is the total weight of every handoff touching that agent:
 * the busiest one is the biggest, which is what the chart is for.
 */
const nodes = [...new Set(links.flatMap((link) => [link.source, link.target]))]
  .map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    value: links
      .filter((link) => link.source === id || link.target === id)
      .reduce((total, link) => total + link.weight, 0),
  }))
  .sort((left, right) => right.value - left.value);

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

export const Default: Story = {
  // Guards the failure this story shipped with: a Graph whose links all get
  // dropped renders `emptyMessage` and throws nothing, so neither the sweep nor
  // a glance at the console catches it. Assert a real node label is on screen.
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByText(String(args.emptyMessage))
    ).not.toBeInTheDocument();
    // The busiest node's label appears twice, once on the node and once in the
    // legend, so this counts rather than expecting a single match.
    await expect(canvas.getAllByText(nodes[0].label).length).toBeGreaterThan(0);
  },
};
